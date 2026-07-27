const Store = require("../models/Store");
const JobHistory = require("../models/JobHistory");
const ItemSnapshot = require("../models/ItemSnapshot");
const RestoreHistory = require("../models/RestoreHistory");
const {QueueManager, QUEUE_NAMES} = require("../bullmq/queueManager");

queueManager = new QueueManager()

/**
 * GET /job-histories
 * Authorization: Bearer <app session JWT>
 *
 * Query (optional):
 *   bcChannelId — filter by channel
 *   status      — filter by job status
 *   limit       — max rows (default 50, max 100)
 *   page        — page number (default 1)
 */
const getJobHistories = async (req, res) => {
  try {
    const store = await Store.findByHash(req.storeHash);
    if (!store || !store.is_active) {
      return res.status(404).json({status: false, message: "Store not found"});
    }

    const filter = { storeHash: req.storeHash };

    const { bcChannelId, status } = req.query;
    if (bcChannelId != null && bcChannelId !== "") {
      const channelId = Number(bcChannelId);
      if (Number.isNaN(channelId)) {
        return res.status(400).json({
          status: false,
          message: "Invalid bcChannelId",
        });
      }
      filter.bcChannelId = channelId;
    }

    if (status != null && status !== "") {
      const allowed = ["pending", "fetching", "updating", "done", "failed"];
      if (!allowed.includes(status)) {
        return res.status(400).json({
          status: false,
          message: `Invalid status. Allowed: ${allowed.join(", ")}`,
        });
      }
      filter.status = status;
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const [histories, total] = await Promise.all([
      JobHistory.aggregate([
        { $match: filter },
        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $addFields: {
            updateType: {
              $cond: {
                if: { $eq: ["$blanksOnly", false] },
                then: "Update All",
                else: "Update Blanks",
              },
            },
          },
        },
      ]),
      JobHistory.countDocuments(filter),
    ]);

    const enriched = await Promise.all(
      histories.map(async (history) => {
        if (history.status !== "pending") return history;
        const historyKey = history.resource === "products" && history.target === "alt" ? "images" : history.resource

        try {
          const job = await queueManager.getJob(QUEUE_NAMES[historyKey], history.jobId);
          if (!job) return history;

          return {
            ...history,
            processedItems : job.progress.processedItems,
            status : job.progress.status,
            totalItems : job.progress.totalItems
          };
        } catch (err) {
          console.warn(`Redis fetch failed for jobId ${history.jobId}:`, err.message);
          return history; // fallback to DB data if Redis fails
        }
      })
    );

    const completedJobIds = enriched
      .filter((h) => h.status === "completed" && h.jobId)
      .map((h) => h.jobId);

    const snapshotCountByJob = {};
    const restoreStatusByJob = {};

    if (completedJobIds.length > 0) {
      const [snapshotAgg, restores] = await Promise.all([
        ItemSnapshot.aggregate([
          {
            $match: {
              storeHash: req.storeHash,
              jobHistoryId: { $in: completedJobIds },
            },
          },
          { $group: { _id: "$jobHistoryId", count: { $sum: 1 } } },
        ]),
        RestoreHistory.find({ sourceJobId: { $in: completedJobIds } })
          .sort({ createdAt: -1 })
          .select("sourceJobId status")
          .lean(),
      ]);

      for (const row of snapshotAgg) {
        snapshotCountByJob[row._id] = row.count;
      }
      for (const row of restores) {
        if (restoreStatusByJob[row.sourceJobId] == null) {
          restoreStatusByJob[row.sourceJobId] = row.status;
        }
      }
    }

    const data = enriched.map((history) => {
      if (history.status !== "completed" || !history.jobId) {
        return { ...history, restorable: false };
      }
      const snapshotCount = snapshotCountByJob[history.jobId] ?? 0;
      const restoreStatus = restoreStatusByJob[history.jobId] ?? null;
      const restorable =
        snapshotCount > 0 &&
        restoreStatus !== "completed" &&
        restoreStatus !== "pending";
      return { ...history, restorable, restoreStatus };
    });

    return res.status(200).json({
      status: true,
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 0,
      },
    });
  } catch (error) {
    console.error("getJobHistories:", error.message);
    return res.status(500).json({
      status: false,
      message: error.message,
    });
  }
};

module.exports = {
  getJobHistories,
};
