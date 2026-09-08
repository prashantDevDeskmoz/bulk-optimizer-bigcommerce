const jwt = require("jsonwebtoken");
const Store = require("../models/Store");
const Plan = require("../models/Plan");
const JobHistory = require("../models/JobHistory");
const { QueueManager, QUEUE_NAMES } = require("../bullmq/queueManager");

const queueManager = new QueueManager();
const ADMIN_TTL_SECONDS = 60 * 60 * 12; // 12 hours

function getAdminSecret() {
  return process.env.ADMIN_JWT_SECRET || process.env.SESSION_JWT_SECRET || process.env.CLIENT_SECRET;
}

/** App load URL using last BigCommerce signed_payload_jwt saved on the store */
function buildLastAccessUrl(lastAccessedPayload) {
  if (!lastAccessedPayload) return null;
  const base = (process.env.FRONTEND_BASE_URL || "").replace(/\/$/, "");
  if (!base) return null;
  return `${base}/load?signed_payload_jwt=${encodeURIComponent(lastAccessedPayload)}`;
}

const adminLogin = async (req, res) => {
  try {
    const { username, password } = req.body;
    const adminUser = process.env.ADMIN_USERNAME || "admin";
    const adminPass = process.env.ADMIN_PASSWORD || "admin";

    if (!username || !password || username !== adminUser || password !== adminPass) {
      return res.status(401).json({ status: false, message: "Invalid credentials" });
    }

    const token = jwt.sign({ role: "admin", username }, getAdminSecret(), {
      expiresIn: ADMIN_TTL_SECONDS,
    });

    return res.status(200).json({
      status: true,
      token,
      expiresIn: ADMIN_TTL_SECONDS,
    });
  } catch (error) {
    console.error("[adminLogin]", error.message);
    return res.status(500).json({ status: false, message: error.message });
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
    const names = Object.values(QUEUE_NAMES);
    const data = await Promise.all(
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
    const search = String(req.query.search || "").trim();
    const status = req.query.status; // active | inactive | all
    const planFilter = String(req.query.plan || "all").trim(); // free | pro | all

    const filter = {};
    if (status === "active") filter.is_active = true;
    if (status === "inactive") filter.is_active = false;
    if (planFilter === "free" || planFilter === "pro") filter.plan = planFilter;
    if (search) {
      filter.$or = [
        { store_hash: { $regex: search, $options: "i" } },
        { store_name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { store_domain: { $regex: search, $options: "i" } },
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
      jobsByStore,
    ] = await Promise.all([
      Store.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select(
          "store_hash email store_name store_domain store_url is_active installed_at uninstalled_at plan access_token updatedAt createdAt planPurchasedAt paypalSubscriptionId trialDaysRemaining last_accessed_payload",
        )
        .lean(),
      Store.countDocuments(filter),
      Store.countDocuments({}),
      Store.countDocuments({ is_active: true }),
      Store.countDocuments({ is_active: false }),
      Store.countDocuments({ plan: "free" }),
      Store.countDocuments({ plan: "pro" }),
      Plan.findOne({ name: "pro" }).lean(),
      JobHistory.aggregate([
        { $group: { _id: "$storeHash", jobs: { $sum: 1 }, failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } }, processed: { $sum: "$processedItems" } } },
      ]),
    ]);

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
      return {
        ...c,
        installStatus: c.is_active ? "installed" : "uninstalled",
        last_access_url: buildLastAccessUrl(c.last_accessed_payload),
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
    const client = await Store.findById(req.params.id).lean();
    if (!client) {
      return res.status(404).json({ status: false, message: "Client not found" });
    }

    return res.status(200).json({
      status: true,
      data: {
        ...client,
        installStatus: client.is_active ? "installed" : "uninstalled",
        last_access_url: buildLastAccessUrl(client.last_accessed_payload),
        last_access_at: client.updatedAt,
      },
    });
  } catch (error) {
    console.error("[getClientById]", error.message);
    return res.status(500).json({ status: false, message: error.message });
  }
};

module.exports = {
  adminLogin,
  getDashboard,
  getPlans,
  updatePlan,
  getWorkersStatus,
  getClients,
  getClientById,
  getAdminSecret,
};
