const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { LOG_DIR } = require("../utils/logger");
const Store = require("../models/Store");
const Plan = require("../models/Plan");
const JobHistory = require("../models/JobHistory");
const { QueueManager, QUEUE_NAMES } = require("../bullmq/queueManager");
const redisClient = require("../redis");

const queueManager = new QueueManager();
const ADMIN_TTL_SECONDS = 60 * 60 * 12; // 12 hours
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const loginFailures = new Map();

function configError(message) {
  const err = new Error(message);
  err.code = "ADMIN_NOT_CONFIGURED";
  return err;
}

function assertAdminConfig() {
  const user = process.env.ADMIN_USERNAME || "";
  const pass = process.env.ADMIN_PASSWORD || "";
  const secret = process.env.ADMIN_JWT_SECRET || "";
  if (!user || pass.length < 12 || secret.length < 32) {
    console.error(
      "[admin] Refusing to start. Set ADMIN_USERNAME, ADMIN_PASSWORD (12+ characters), and ADMIN_JWT_SECRET (32+ characters).",
    );
    process.exit(1);
  }
}

function getAdminSecret() {
  const secret = process.env.ADMIN_JWT_SECRET || "";
  if (secret.length < 32) throw configError("Admin auth is not configured");
  return secret;
}

function secretsMatch(input, expected) {
  const left = crypto.createHash("sha256").update(String(input ?? ""), "utf8").digest();
  const right = crypto.createHash("sha256").update(String(expected ?? ""), "utf8").digest();
  return crypto.timingSafeEqual(left, right);
}

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function recentFailures(ip) {
  const now = Date.now();
  const recent = (loginFailures.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (recent.length) loginFailures.set(ip, recent);
  else loginFailures.delete(ip);
  return recent;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

assertAdminConfig();

/** App load URL using last BigCommerce signed_payload_jwt saved on the store */
function buildLastAccessUrl(lastAccessedPayload) {
  if (!lastAccessedPayload) return null;
  const base = (process.env.FRONTEND_BASE_URL || "").replace(/\/$/, "");
  if (!base) return null;
  return `${base}/load?signed_payload_jwt=${encodeURIComponent(lastAccessedPayload)}`;
}

const adminLogin = async (req, res) => {
  const ip = clientIp(req);
  try {
    if (recentFailures(ip).length >= LOGIN_MAX_FAILURES) {
      return res.status(429).json({ status: false, message: "Too many login attempts. Try again later." });
    }

    const adminUser = process.env.ADMIN_USERNAME || "";
    const adminPass = process.env.ADMIN_PASSWORD || "";
    if (adminPass.length < 12) throw configError("Admin auth is not configured");

    const { username, password } = req.body || {};
    const userOk = secretsMatch(username, adminUser);
    const passOk = secretsMatch(password, adminPass);
    if (!userOk || !passOk) {
      const recent = recentFailures(ip);
      recent.push(Date.now());
      loginFailures.set(ip, recent);
      return res.status(401).json({ status: false, message: "Invalid credentials" });
    }

    loginFailures.delete(ip);
    const token = jwt.sign({ role: "admin", username: adminUser }, getAdminSecret(), {
      expiresIn: ADMIN_TTL_SECONDS,
    });

    return res.status(200).json({
      status: true,
      token,
      expiresIn: ADMIN_TTL_SECONDS,
    });
  } catch (error) {
    console.error("[adminLogin]", error.message);
    const message = error.code === "ADMIN_NOT_CONFIGURED" ? "Admin auth is not configured" : "Internal server error";
    return res.status(500).json({ status: false, message });
  }
};

const getDashboard = async (req, res) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      totalStores,
      activeStores,
      inactiveStores,
      freeStores,
      proStores,
      jobsLast24h,
      jobsLast7d,
      jobsByResource,
      jobsByStatus,
      processedLast7d,
    ] = await Promise.all([
      Store.countDocuments({}),
      Store.countDocuments({ is_active: true }),
      Store.countDocuments({ is_active: false }),
      Store.countDocuments({ plan: "free" }),
      Store.countDocuments({ plan: "pro" }),
      JobHistory.countDocuments({ startedAt: { $gte: dayAgo } }),
      JobHistory.countDocuments({ startedAt: { $gte: sevenDaysAgo } }),
      JobHistory.aggregate([
        { $match: { startedAt: { $gte: sevenDaysAgo } } },
        { $group: { _id: "$resource", count: { $sum: 1 } } },
      ]),
      JobHistory.aggregate([
        { $match: { startedAt: { $gte: sevenDaysAgo } } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      JobHistory.aggregate([
        { $match: { startedAt: { $gte: sevenDaysAgo } } },
        { $group: { _id: null, total: { $sum: "$processedItems" } } },
      ]),
    ]);

    let queues = [];
    let redis = { status: "ok", message: "Connected" };
    if (redisClient.status !== "ready") {
      redis = { status: "error", message: `Redis ${redisClient.status}` };
    } else {
      try {
        const names = Object.values(QUEUE_NAMES);
        queues = await Promise.all(
          names.map(async (name) => {
            const queue = queueManager.queues[name];
            const counts = await queue.getJobCounts(
              "waiting",
              "active",
              "completed",
              "failed",
              "delayed",
              "paused",
            );
            return { name, ...counts };
          }),
        );
      } catch (err) {
        redis = {
          status: "error",
          message: err.message || "Redis unavailable",
        };
      }
    }

    const queueTotals = queues.reduce(
      (acc, q) => ({
        waiting: acc.waiting + (q.waiting || 0),
        active: acc.active + (q.active || 0),
        failed: acc.failed + (q.failed || 0),
        completed: acc.completed + (q.completed || 0),
      }),
      { waiting: 0, active: 0, failed: 0, completed: 0 },
    );

    const byResource = { products: 0, categories: 0, brands: 0 };
    for (const row of jobsByResource) {
      if (row._id && byResource[row._id] !== undefined) byResource[row._id] = row.count;
    }

    const byStatus = { pending: 0, completed: 0, failed: 0 };
    for (const row of jobsByStatus) {
      if (row._id && byStatus[row._id] !== undefined) byStatus[row._id] = row.count;
    }

    const healthOk = redis.status === "ok";
    const health = {
      overall: healthOk ? "ok" : "degraded",
      database: { status: "ok", message: "Connected" },
      redis,
      checkedAt: new Date().toISOString(),
    };

    return res.status(200).json({
      status: true,
      data: {
        totalStores,
        activeStores,
        inactiveStores,
        freeStores,
        proStores,
        jobsLast24h,
        jobsLast7d,
        itemsProcessedLast7d: processedLast7d[0]?.total || 0,
        jobsByResource: byResource,
        jobsByStatus: byStatus,
        queues,
        queueTotals,
        health,
      },
    });
  } catch (error) {
    console.error("[getDashboard]", error.message);
    return res.status(500).json({ status: false, message: error.message });
  }
};

const getPlans = async (req, res) => {
  try {
    const plans = await Plan.find({}).sort({ price: 1 }).lean();
    return res.status(200).json({ status: true, data: plans });
  } catch (error) {
    console.error("[getPlans]", error.message);
    return res.status(500).json({ status: false, message: error.message });
  }
};

const updatePlan = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ status: false, message: "Plan not found" });
    }

    const { description, itemLimit, period, price, paypalPlanId } = req.body;

    const update = {};
    if (description !== undefined) update.description = description;
    if (period !== undefined) update.period = period;
    if (price !== undefined) update.price = Number(price);
    if (paypalPlanId !== undefined) update.paypalPlanId = paypalPlanId;
    if (itemLimit !== undefined) {
      update.itemLimit = itemLimit === null || itemLimit === "" ? null : Number(itemLimit);
    }

const plan = await Plan.findByIdAndUpdate(id, { $set: update }, { returnDocument: "after" }).lean();
    if (!plan) {
      return res.status(404).json({ status: false, message: "Plan not found" });
    }

    return res.status(200).json({ status: true, data: plan, message: "Plan updated" });
  } catch (error) {
    console.error("[updatePlan]", error.message);
    return res.status(500).json({ status: false, message: error.message });
  }
};

const getWorkersStatus = async (req, res) => {
  try {
    if (redisClient.status !== "ready") {
      return res.status(503).json({ status: false, message: `Redis ${redisClient.status}` });
    }
    const names = Object.values(QUEUE_NAMES);
    const data = await Promise.all(
      names.map(async (name) => {
        const queue = queueManager.queues[name];
        try {
          const [counts, workers, failedJobs] = await Promise.all([
            queue.getJobCounts("waiting", "active", "completed", "failed", "delayed", "paused"),
            queue.getWorkersCount().catch(() => null),
            queue.getFailed(0, 4),
          ]);
          const recentFailed = failedJobs.filter(Boolean).map((job) => ({
            id: job.id,
            storeHash: job.data?.storeHash,
            failedReason: job.failedReason,
            attemptsMade: job.attemptsMade,
            finishedOn: job.finishedOn,
          }));
          return { name, ...counts, workers, recentFailed };
        } catch (err) {
          return {
            name,
            waiting: 0,
            active: 0,
            completed: 0,
            failed: 0,
            delayed: 0,
            paused: 0,
            error: err.message || "Queue unavailable",
          };
        }
      }),
    );

    return res.status(200).json({ status: true, data });
  } catch (error) {
    console.error("[getWorkersStatus]", error.message);
    return res.status(500).json({ status: false, message: error.message });
  }
};

const getClients = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const search = String(req.query.search || "").trim().slice(0, 100);
    const status = req.query.status; // active | inactive | all
    const planFilter = String(req.query.plan || "all").trim(); // free | pro | all

    const filter = {};
    if (status === "active") filter.is_active = true;
    if (status === "inactive") filter.is_active = false;
    if (planFilter === "free" || planFilter === "pro") filter.plan = planFilter;
    if (search) {
      const pattern = escapeRegex(search);
      filter.$or = [
        { store_hash: { $regex: pattern, $options: "i" } },
        { store_name: { $regex: pattern, $options: "i" } },
        { email: { $regex: pattern, $options: "i" } },
        { store_domain: { $regex: pattern, $options: "i" } },
      ];
    }

    const [
      clients,
      total,
      summaryTotal,
      summaryActive,
      summaryInactive,
      summaryFree,
      summaryPro,
      proPlan,
    ] = await Promise.all([
      Store.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select(
          "store_hash email store_name store_domain store_url is_active installed_at uninstalled_at plan updatedAt createdAt planPurchasedAt paypalSubscriptionId trialDaysRemaining last_accessed_payload",
        )
        .lean(),
      Store.countDocuments(filter),
      Store.countDocuments({}),
      Store.countDocuments({ is_active: true }),
      Store.countDocuments({ is_active: false }),
      Store.countDocuments({ plan: "free" }),
      Store.countDocuments({ plan: "pro" }),
      Plan.findOne({ name: "pro" }).lean(),
    ]);

    const storeHashes = clients.map((c) => c.store_hash);
    const jobsByStore = storeHashes.length
      ? await JobHistory.aggregate([
          { $match: { storeHash: { $in: storeHashes } } },
          {
            $group: {
              _id: "$storeHash",
              jobs: { $sum: 1 },
              failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
              processed: { $sum: "$processedItems" },
            },
          },
        ])
      : [];

    const jobsMap = Object.fromEntries(
      jobsByStore.map((j) => [j._id, { jobs: j.jobs, failed: j.failed, processed: j.processed }]),
    );

    const proPrice = Number(proPlan?.price || 0);
    const summary = {
      totalClients: summaryTotal,
      activeClients: summaryActive,
      inactiveClients: summaryInactive,
      freePlan: summaryFree,
      paidPlan: summaryPro,
      proPrice,
      estimatedMonthlyRevenue: summaryPro * proPrice,
      byPlan: {
        free: summaryFree,
        pro: summaryPro,
      },
    };

    const data = clients.map((c) => {
      const stats = jobsMap[c.store_hash] || { jobs: 0, failed: 0, processed: 0 };
      const { last_accessed_payload, ...rest } = c;
      return {
        ...rest,
        installStatus: c.is_active ? "installed" : "uninstalled",
        last_access_url: buildLastAccessUrl(last_accessed_payload),
        last_access_at: c.updatedAt,
        jobStats: stats,
      };
    });

    return res.status(200).json({ status: true, data, total, page, limit, summary });
  } catch (error) {
    console.error("[getClients]", error.message);
    return res.status(500).json({ status: false, message: error.message });
  }
};

const getClientById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ status: false, message: "Client not found" });
    }

    const client = await Store.findById(id).lean();
    if (!client) {
      return res.status(404).json({ status: false, message: "Client not found" });
    }

    const { last_accessed_payload, ...safeClient } = client;
    return res.status(200).json({
      status: true,
      data: {
        ...safeClient,
        installStatus: client.is_active ? "installed" : "uninstalled",
        last_access_url: buildLastAccessUrl(last_accessed_payload),
        last_access_at: client.updatedAt,
      },
    });
  } catch (error) {
    console.error("[getClientById]", error.message);
    return res.status(500).json({ status: false, message: error.message });
  }
};

const getLogType = (entry) =>
  entry.message === "Request failed" ? "request" : entry.message?.includes("Job failed") ? "job" : "system";
const getLogLevel = (entry) => (entry.status && entry.status < 500 ? "warning" : "error");

const getLogs = async (req, res) => {
  try {
    const dates = (await fs.promises.readdir(LOG_DIR))
      .map((name) => name.match(/^error-(\d{4}-\d{2}-\d{2})\.log$/)?.[1])
      .filter(Boolean)
      .sort()
      .reverse();
    const date = dates.includes(req.query.date) ? req.query.date : dates[0];
    if (!date) return res.status(200).json({ status: true, dates, date: null, data: [] });

    const storeHash = String(req.query.storeHash || "").trim();
    const { type = "", level = "" } = req.query;
    const limit = Math.min(Number(req.query.limit) || 200, 1000);

    const lines = (await fs.promises.readFile(path.join(LOG_DIR, `error-${date}.log`), "utf8")).split("\n");
    const data = [];
    for (let i = lines.length - 1; i >= 0 && data.length < limit; i--) {
      if (!lines[i]) continue;
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      entry.type = getLogType(entry);
      entry.level = getLogLevel(entry);
      if (storeHash && !entry.storeHash?.includes(storeHash)) continue;
      if (type && entry.type !== type) continue;
      if (level && entry.level !== level) continue;
      data.push(entry);
    }

    return res.status(200).json({ status: true, dates, date, data });
  } catch (error) {
    console.error("[getLogs]", error.message);
    return res.status(500).json({ status: false, message: error.message });
  }
};

module.exports = {
  getLogs,
  adminLogin,
  getDashboard,
  getPlans,
  updatePlan,
  getWorkersStatus,
  getClients,
  getClientById,
  getAdminSecret,
};
