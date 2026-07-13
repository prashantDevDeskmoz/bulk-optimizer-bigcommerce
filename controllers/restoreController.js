const axios = require("axios");
const Store = require("../models/Store");
const ItemSnapshot = require("../models/ItemSnapshot");
const JobHistory = require("../models/JobHistory");
const RestoreHistory = require("../models/RestoreHistory");
const { QueueManager, QUEUE_NAMES } = require("../bullmq/queueManager");
const { batchUpdateProductsUrl, batchUpdateCategoriesUrl, updateBrandUrl, updateImageUrl } = require("../utils/bcApi");
const queueManager = new QueueManager();

const getRestoreItems = async (req, res) => {
  try {
    const {page = 1, limit = 10 , itemType, bcChannelId, search} = req.body;

    // search with search regex of fields.name
    // group by itemId and push the target(meta, alt, title) into an array
    const items = await ItemSnapshot.aggregate([
      {$match : {storeHash: req.storeHash, 
        ...(itemType !== "brand" ? {bcChannelId} : {}), 
        itemType: itemType,
        "fields.name": {$regex: search, $options: "i"},
        // is_restored: {$ne: true}
        }
      },
      {$sort : {capturedAt: -1}},
      {
        $group :{
          _id : "$itemId",
          name : {$first : "$fields.name"},
          target : {$push : "$target"},
          capturedAt : {$push : "$capturedAt"},
          // slot : {$push : "$slot"},  // will be used later for if more than 1 snapshots are needed for a single item
          pageUrl : {$first : "$fields.item_url"},
        }
      },
      {$facet:{
        items : [
          {$skip : (page - 1) * limit},
          {$limit : limit},
        ],
        total : [
          {$count : "count"}
        ]
      }},
    ]);

    return res.status(200).json({ status: true, data: items[0].items, total: items[0].total[0]?.count });
  } catch (error) {
    console.error("[getRestoreItems]", error.message);
    return res.status(500).json({ status: false, message: error.message, data: [] });
  }
}

const restoreItems = async (req, res) => {
  console.log("[restoreItems]", req.body);

  try {
    const { itemId, target , itemType} = req.body;
    const store = await Store.findByHash(req.storeHash);
    if(!store) {
      return res.status(404).json({ status: false, message: "Store not found" });
    }

    const item = await ItemSnapshot.findOne({ itemId, target, itemType, storeHash: req.storeHash });
    if(!item) {
      return res.status(404).json({ status: false, message: "Item not found" });
    }

    if(target === "alt" && itemType === "product") {
      const images = item.fields.images;

      const results = await Promise.allSettled(images.map(async (image) => {
        return axios.put(updateImageUrl(req.storeHash, itemId, image.imageId), {
          description: image.altText,
        }, { headers: { "X-Auth-Token": store.access_token, "Content-Type": "application/json" } });
      }));
    }
    else if(itemType === "product") {
      const response = await axios.put(batchUpdateProductsUrl(req.storeHash), [{
        id: itemId,
        ...(target === "meta" && { meta_description: item.fields.meta_description }),
        ...(target === "title" && { page_title: item.fields.page_title }),
      }], { headers: { "X-Auth-Token": store.access_token, "Content-Type": "application/json" } });
    }
    else if(itemType === "category") {
      const response = await axios.put(batchUpdateCategoriesUrl(req.storeHash), [{
        category_id: itemId,
        ...(target === "meta" && { meta_description: item.fields.meta_description }),
        ...(target === "title" && { page_title: item.fields.page_title }),
      }], { headers: { "X-Auth-Token": store.access_token, "Content-Type": "application/json" } });
    }
    else if(itemType === "brand") {
      const response = await axios.put(updateBrandUrl(req.storeHash, itemId), {
        ...(target === "meta" && { meta_description: item.fields.meta_description }),
        ...(target === "title" && { page_title: item.fields.page_title }),
      }, { headers: { "X-Auth-Token": store.access_token, "Content-Type": "application/json" } });
    }
    else{
      return res.status(400).json({ status: false, message: "Invalid target or item type" });
    }

    await item.deleteOne();
    return res.status(200).json({ status: true, message: "Item restored successfully" });

  } catch (error) {
    console.error("[restoreItems]", error);
    return res.status(500).json({ status: false, message: error.message });
  }
}

const getRestoreHistory = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    const [records, total] = await Promise.all([
      RestoreHistory.find({ storeHash: req.storeHash })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      RestoreHistory.countDocuments({ storeHash: req.storeHash }),
    ]);

    return res.status(200).json({
      status: true,
      data: records,
      total,
      page,
      limit,
    });
  } catch (error) {
    console.error("[getRestoreHistory]", error);
    return res.status(500).json({ status: false, message: error.message, data: [] });
  }
};

const bulkRestore = async (req, res) => {
  try {
    const { jobId } = req.body;

    const store = await Store.findByHash(req.storeHash);

    if (!store) {
      return res.status(404).json({ status: false, message: "Store not found" });
    }

    const sourceJob = await JobHistory.findOne({ jobId, storeHash: req.storeHash });
    if (!sourceJob) {
      return res.status(404).json({ status: false, message: "Bulk job not found" });
    }
    if (sourceJob.status !== "completed") {
      return res.status(400).json({ status: false, message: "Bulk job is not completed yet" });
    }

    const snapshotCount = await ItemSnapshot.countDocuments({ jobHistoryId: jobId });
    if (snapshotCount === 0) {
      return res.status(400).json({ status: false, message: "No snapshots available to restore" });
    }

    const pendingRestore = await RestoreHistory.findOne({
      storeHash: req.storeHash,
      status: "pending",
    });
    if (pendingRestore) {
      return res.status(400).json({
        status: false,
        message: "Restore job already in progress, please wait for it to complete",
      });
    }

    const pendingForJob = await RestoreHistory.findOne({
      sourceJobId: jobId,
      status: "pending",
    });
    if (pendingForJob) {
      return res.status(400).json({
        status: false,
        message: "A restore for this job is already in progress",
      });
    }

    const pendingBulk = await JobHistory.findOne({
      storeHash: req.storeHash,
      resource: sourceJob.resource,
      target: sourceJob.target,
      status: { $in: ["pending", "fetching", "updating"] },
    }).lean();
    if (pendingBulk) {
      return res.status(400).json({
        status: false,
        message: "A bulk update is in progress for this item type and field. Wait for it to finish before restoring.",
      });
    }

    const restoreJobId = `restore-${sourceJob.target}-${Date.now()}-${req.storeHash}`;
    const jobOptions = { jobId: restoreJobId };
    const jobData = {
      sourceJobId: jobId,
      accessToken: store.access_token,
      storeHash: req.storeHash,
    };

    let bullJob = null;
    if (sourceJob.target === "alt") {
      bullJob = await queueManager.addJob(QUEUE_NAMES.restoreImages, jobData, jobOptions);
    } else {
      bullJob = await queueManager.addJob(QUEUE_NAMES.restore, jobData, jobOptions);
    }

    await RestoreHistory.create({
      restoreJobId: bullJob.id,
      sourceJobId: jobId,
      storeHash: req.storeHash,
      bcChannelId: sourceJob.bcChannelId,
      resource: sourceJob.resource,
      target: sourceJob.target,
      status: "pending",
      totalItems: snapshotCount,
    });

    return res.status(200).json({
      status: true,
      message: "Restore Job added to queue",
      restoreJobId: bullJob.id,
    });
  } catch (error) {
    console.error("[bulkRestore]", error);
    return res.status(500).json({ status: false, message: error.message });
  }
};

const getRestoreJobs = async (req, res) => {
  try {
    const store = await Store.findByHash(req.storeHash);
    if (!store) {
      return res.status(404).json({ status: false, message: "Store not found" });
    }

    const limit = 10;

    const jobsPerGroup = 2;
    const collectionName = JobHistory.collection.name;
    const restoreCollectionName = RestoreHistory.collection.name;
    const [result] = await ItemSnapshot.aggregate([
      {
        $match: {
          storeHash: req.storeHash,
          jobHistoryId: { $exists: true, $ne: null },
        },
      },
      {
        $group: {
          _id: "$jobHistoryId",
          restorableCount: {
            $sum: {
              $cond: {
                if: { $eq: ["$target", "alt"] },
                then: { $size: { $ifNull: ["$fields.images", []] } },
                else: 1,
              },
            },
          },
        },
      },
      {
        $lookup: {
          from: collectionName,
          localField: "_id",
          foreignField: "jobId",
          as: "jobHistory",
        },
      },
      { $unwind: "$jobHistory" },
      {
        $lookup: {
          from: restoreCollectionName,
          let: { sourceJobId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$sourceJobId", "$$sourceJobId"] },
                    { $eq: ["$status", "completed"] },
                  ],
                },
              },
            },
            { $limit: 1 },
          ],
          as: "completedRestore",
        },
      },
      {
        $match: {
          "jobHistory.storeHash": req.storeHash,
          "jobHistory.status": "completed",
          restorableCount: { $gt: 0 },
          completedRestore: { $size: 0 },
        },
      },
      {
        $lookup: {
          from: restoreCollectionName,
          let: { sourceJobId: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$sourceJobId", "$$sourceJobId"] } } },
            { $sort: { createdAt: -1 } },
            { $limit: 1 },
          ],
          as: "restoreHistory",
        },
      },
      {
        $addFields: {
          restoreHistory: { $arrayElemAt: ["$restoreHistory", 0] },
        },
      },
      {
        $sort: {
          "jobHistory.completedAt": -1,
          "jobHistory.startedAt": -1,
        },
      },
      {
        // Up to 2 recent jobs per resource + target (e.g. product/alt, category/meta)
        $group: {
          _id: {
            resource: "$jobHistory.resource",
            target: "$jobHistory.target",
          },
          jobs: { $push: "$$ROOT" },
        },
      },
      {
        $project: {
          jobs: { $slice: ["$jobs", jobsPerGroup] },
        },
      },
      { $unwind: "$jobs" },
      { $replaceRoot: { newRoot: "$jobs" } },
      {
        $sort: {
          "jobHistory.completedAt": -1,
          "jobHistory.startedAt": -1,
        },
      },
      {
        $facet: {
          jobs: [
            {
              $project: {
                _id: 0,
                jobId: "$_id",
                restorableCount: 1,
                resource: "$jobHistory.resource",
                target: "$jobHistory.target",
                template: "$jobHistory.template",
                status: "$jobHistory.status",
                totalItems: "$jobHistory.totalItems",
                processedItems: "$jobHistory.processedItems",
                blanksOnly: "$jobHistory.blanksOnly",
                startedAt: "$jobHistory.startedAt",
                completedAt: "$jobHistory.completedAt",
                restoreStatus: "$restoreHistory.status",
                bcChannelId: "$jobHistory.bcChannelId",
                updateType: {
                  $cond: {
                    if: { $eq: ["$jobHistory.blanksOnly", false] },
                    then: "Update All",
                    else: "Update Blanks",
                  },
                },
              },
            },
          ],
          total: [{ $count: "count" }],
        },
      },
    ]);

    return res.status(200).json({
      status: true,
      data: result?.jobs ?? [],
      total: result?.total[0]?.count ?? 0,
      limit,
    });
  } catch (error) {
    console.error("[getRestoreJobs]", error);
    return res.status(500).json({ status: false, message: error.message });
  }
};

module.exports = {
  getRestoreItems,
  getRestoreHistory,
  restoreItems,
  bulkRestore,
  getRestoreJobs,
};
