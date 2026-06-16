const axios = require("axios");
const Store = require("../models/Store");
const ItemSnapshot = require("../models/ItemSnapshot");
const JobHistory = require("../models/JobHistory");
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
        is_restored: {$ne: true}
        }
      },
      {$sort : {capturedAt: -1}},
      {
        $group :{
          _id : "$itemId",
          name : {$first : "$fields.name"},
          target : {$push : "$target"},
          capturedAt : {$push : "$capturedAt"},
          slot : {$push : "$slot"},
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
    const { itemId, target , itemType, slot = 1 } = req.body;
    const store = await Store.findByHash(req.storeHash);
    if(!store) {
      return res.status(404).json({ status: false, message: "Store not found" });
    }

    const item = await ItemSnapshot.findOne({ itemId, target, itemType,slot, storeHash: req.storeHash });
    if(!item) {
      return res.status(404).json({ status: false, message: "Item not found" });
    }

    if(target === "alt" && itemType === "product") {
      const images = item.fields.images;
      for(const image of images) {
        const response = await axios.put(updateImageUrl(req.storeHash, itemId, image.imageId), {
          description: image.altText,
        }, { headers: { "X-Auth-Token": store.access_token, "Content-Type": "application/json" } });
      }
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

    await item.updateOne({ $set: { is_restored: true } });
    return res.status(200).json({ status: true, message: "Item restored successfully" });

  } catch (error) {
    console.error("[restoreItems]", error);
    return res.status(500).json({ status: false, message: error.message });
  }
}

const getRestoreHistory = async (req, res) => {
}

const bulkRestore = async (req, res) => {
  try {
    const { jobId } = req.body;

    const store = await Store.findByHash(req.storeHash);

    if(!store) {
      return res.status(404).json({ status: false, message: "Store not found" });
    }
    const jobHistory = await JobHistory.findOne({ restoreStatus: { $in: ["pending"] } });

    if(jobHistory) {
      return res.status(400).json({ status: false, message: "Restore job already in progress, please wait for it to complete" });
    }

    const addJob = await queueManager.addJob(QUEUE_NAMES.restore, { jobId, accessToken: store.access_token, storeHash: req.storeHash });


    await JobHistory.updateOne({ jobId }, { $set: { restoreStatus: "pending" } });
    return res.status(200).json({ status: true, message: "Restore Job added to queue" });
  } catch (error) {
    console.error("[bulkRestore]", error);
    return res.status(500).json({ status: false, message: error.message });
  }
}

const getRestoreJobs = async (req, res) => {
  try {
    const store = await Store.findByHash(req.storeHash);
    if (!store) {
      return res.status(404).json({ status: false, message: "Store not found" });
    }

    const limit = 10;
    const collectionName = JobHistory.collection.name;

    const [result] = await ItemSnapshot.aggregate([
      {
        $match: {
          storeHash: req.storeHash,
          is_restored: { $ne: true },
          jobHistoryId: { $exists: true, $ne: null },
        },
      },
      {
        $group: {
          _id: "$jobHistoryId",
          restorableCount: { $sum: 1 },
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
        $match: {
          "jobHistory.storeHash": req.storeHash,
          "jobHistory.status": "completed",
          "jobHistory.restoreStatus": { $in: [null, "pending"] },
        },
      },
      {
        $facet: {
          jobs: [
            { $sort: { "jobHistory.completedAt": -1, "jobHistory.startedAt": -1 } },
            { $limit: limit },
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
                restoreStatus: "$jobHistory.restoreStatus",
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
