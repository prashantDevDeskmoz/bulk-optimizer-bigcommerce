const { Worker } = require("bullmq");
const redis = require("../../redis");
const ItemSnapshot = require("../../models/ItemSnapshot");
const axios = require("axios");
const JobHistory = require("../../models/JobHistory");
const RestoreHistory = require("../../models/RestoreHistory");
const { updateBulkProducts, updateBulkCategories, updateBulkBrands, updateBulkImageAltText, PRODUCT_BATCH_LIMIT, NORMAL_THROTTLE_MS, RATE_LIMIT_LOW_THRESHOLD } = require("../workerService");
const { updateImageUrl } = require("../../utils/bcApi");

const headers = (accessToken) => {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Auth-Token": accessToken,
  };
};

const deleteRestoredSnapshots = async ({sourceJobId, itemData, target, lastUpdatedId, failedIds = [], failedImageKeys = new Set()}) => {
  if (target === "alt") {
    for (const item of itemData) {
      const images = item.fields?.images ?? [];
      if (images.length === 0) continue;
      const remainingImages = images.filter((img) =>
        failedImageKeys.has(`${item.itemId}-${img.imageId}`),
      );
      if (remainingImages.length === 0) {
        await ItemSnapshot.deleteOne({ _id: item._id });
      } else if (remainingImages.length < images.length) {
        await ItemSnapshot.updateOne(
          { _id: item._id },
          { $set: { "fields.images": remainingImages } },
        );
      }
      // all images failed → snapshot unchanged
    }
    return;
  }
  
  if (lastUpdatedId != null && itemData.length > 0) {
    const lastUpdatedIndex = itemData.findIndex((item) => item.itemId === lastUpdatedId);

    if (lastUpdatedIndex == -1) {
      return;
    }
    itemData = itemData.slice(0,lastUpdatedIndex + 1);
  }
  
  const failedSet = new Set(failedIds);
  const restoredItemIds = itemData
    .map((item) => item.itemId)
    .filter((id) => !failedSet.has(id));

  if (restoredItemIds.length > 0) {
    await ItemSnapshot.deleteMany({
      jobHistoryId: sourceJobId,
      itemId: { $in: restoredItemIds },
    });
  }
};

const getBatchUpdates = async ({sourceJobId, lastId, limit = 250}) => {
  const query = { jobHistoryId: sourceJobId };
  if (lastId) query._id = { $gt: lastId };

  const batchUpdates = await ItemSnapshot.find(query).sort({ _id: 1 }).limit(limit).lean();
  const isLast = batchUpdates.length < limit;
  return { batchUpdates, isLast };
};

const buildFailedImageKeys = (itemData, succeededImageKeys) => {
  const failedImageKeys = new Set();
  for (const item of itemData) {
    for (const image of item.fields?.images ?? []) {
      const key = `${item.itemId}-${image.imageId}`;
      if (!succeededImageKeys.has(key)) failedImageKeys.add(key);
    }
  }
  return failedImageKeys;
};

const markSucceededThrough = (itemData, lastProductId, lastImageId, succeededImageKeys) => {
  outer: for (const item of itemData) {
    for (const image of item.fields?.images ?? []) {
      succeededImageKeys.add(`${item.itemId}-${image.imageId}`);
      if (item.itemId === lastProductId && image.imageId === lastImageId) break outer;
    }
  }
};


const restoreWorker = new Worker(
  "bulk-restore",
  async (job) => {
    const { sourceJobId: sourceJobIdFromData, jobId: legacyJobId, accessToken, storeHash } = job.data;
    const sourceJobId = sourceJobIdFromData || legacyJobId;

    let currentBatch = null;

    let lastId = null;
      let done = 0;
      let total = 0;
    try {
      if (!sourceJobId) throw new Error("sourceJobId is required for restore jobs") 

      // const restoreHistory = await RestoreHistory.findOne({ restoreJobId: job.id }).lean();
      // if (!restoreHistory) { throw new Error(`Restore history not found for job ${job.id}`)}

      const jobHistory = await JobHistory.findOne({ jobId: sourceJobId }).lean();
      if (!jobHistory) throw new Error(`Job history not found for job ${sourceJobId}`)

      if (jobHistory.status !== "completed") { throw new Error(`Job ${sourceJobId} is not completed yet`)}

      while (true) {
          const { batchUpdates: itemData, isLast } = await getBatchUpdates({sourceJobId, lastId});
          if (itemData.length === 0) break;
          lastId = itemData[itemData.length - 1]._id;

          currentBatch = itemData;
          total += itemData.length;

          const updatablePayload = [];
          for (const item of itemData) {
            updatablePayload.push({
              [jobHistory.resource === "categories" ? "category_id" : "id"]: item.itemId,
              ...(jobHistory.target === "title" && { page_title: item.fields.page_title }),
              ...(jobHistory.target === "meta" && { meta_description: item.fields.meta_description }),
            });
          }

          let failedIds = [];

          if (jobHistory.resource === "products") {
            const result = await updateBulkProducts({storeHash, updatablePayload, done, accessToken, job, type: "restore"});
            done = result.done;
            failedIds = result.failedIds ?? [];

            await job.updateProgress({ status: "restored", processedItems: done, totalItems: total });
            await RestoreHistory.updateOne(
              { restoreJobId: job.id },
              { $set: { processedItems: done } },
            );
          } else if (jobHistory.resource === "categories") {
            const result = await updateBulkCategories({storeHash, updatablePayload, done, accessToken, job, type: "restore"});
            done = result.done;
            failedIds = result.failedIds ?? [];

            await job.updateProgress({ status: "restored", processedItems: done, totalItems: total });
            await RestoreHistory.updateOne(
              { restoreJobId: job.id },
              { $set: { processedItems: done } },
            );
          } else if (jobHistory.resource === "brands") {
            const result = await updateBulkBrands({storeHash, updatablePayload, done, accessToken, job, type: "restore"});
            done = result.done;
            failedIds = result.failedIds ?? [];

            await job.updateProgress({ status: "restored", processedItems: done, totalItems: total });
            await RestoreHistory.updateOne(
              { restoreJobId: job.id },
              { $set: { processedItems: done } },
            );
          } else {
            throw new Error(`Invalid type of items ${jobHistory.resource}`);
          }


          await deleteRestoredSnapshots({
            sourceJobId,
            itemData,
            target: jobHistory.target,
            failedIds,
          });

          if (isLast) break;
      }
      console.log("total,done:::::::::::::::::::::::::::::::::::::", total, done);

      await RestoreHistory.updateOne(
        { restoreJobId: job.id },
        { $set: { status: "completed", completedAt: new Date(), processedItems: done, totalItems: total } },
      );
    } catch (error) {
      const progress = job.progress ?? {};
      const failedIds = error.failedIds ?? progress.failedIds ?? [];
      const lastUpdatedId = error.lastUpdatedId ?? progress.lastUpdatedId;

      console.error("[Restore Worker] :error:", error?.response?.data || error.message);

      if (currentBatch?.length && lastUpdatedId != null) {
        await deleteRestoredSnapshots({
          sourceJobId,
          itemData: currentBatch,
          failedIds,
          lastUpdatedId, // add slice logic inside deleteRestoredSnapshots
        });
      }

      await RestoreHistory.updateOne(
        { restoreJobId: job.id },
        { $set: { status: "failed", completedAt: new Date(), totalItems: total, processedItems: done } },
      );
      throw error;
    }
  },
  {
    connection: redis,
    concurrency: 2,
  },
);

const restoreWorkerImages = new Worker(
  "bulk-restore-images",
  async (job) => {
    const { sourceJobId: sourceJobIdFromData, jobId: legacyJobId, accessToken, storeHash } = job.data;
    const sourceJobId = sourceJobIdFromData || legacyJobId;

    let currentBatch = null;
    let lastId = null;
    let done = 0;
    let total = 0;
    const succeededImageKeys = new Set();

    try {
      if (!sourceJobId) throw new Error("sourceJobId is required for restore jobs")

      // const restoreHistory = await RestoreHistory.findOne({ restoreJobId: job.id }).lean();
      // if (!restoreHistory) { throw new Error(`Restore history not found for job ${job.id}`) }

      const jobHistory = await JobHistory.findOne({ jobId: sourceJobId }).lean();
      if (!jobHistory) throw new Error(`Job history not found for job ${sourceJobId}`)

      if (jobHistory.status !== "completed") { throw new Error(`Job ${sourceJobId} is not completed yet`) }

      while (true) {
        const { batchUpdates: itemData, isLast } = await getBatchUpdates({sourceJobId, lastId});
        if (itemData.length === 0) break;
        lastId = itemData[itemData.length - 1]._id;

        currentBatch = itemData;

        const updatablePayload = [];

        for (const item of itemData) {
          updatablePayload.push({
            id: item.itemId,
            images: (item.fields?.images ?? []).map((image) => ({
              id: image.imageId,
              alt_text: image.altText,
            })),
          });
        }

        const images = currentBatch.flatMap(item => item.fields?.images ?? []);
        total += images.length;

        const result = await updateBulkImageAltText({storeHash, updatablePayload, done, accessToken, job, type: "restore", canBeUpdated: null});
        done = result.done;

        await job.updateProgress({ status: "restored", processedItems: done, totalItems: total });
        await RestoreHistory.updateOne(
          { restoreJobId: job.id },
          { $set: { processedItems: done, totalItems: total } },
        );

        const failedImageKeys = new Set(
          (result.failedImages ?? []).map((f) => `${f.itemId}-${f.imageId}`),
        );
        await deleteRestoredSnapshots({
          sourceJobId,
          itemData: currentBatch,
          target: "alt",
          failedImageKeys,
        });

        if (isLast) break;

      }

      await RestoreHistory.updateOne(
        { restoreJobId: job.id },
        { $set: { status: "completed", completedAt: new Date(), processedItems: done, totalItems: total } },
      );

    } catch (error) {
      const progress = job.progress ?? {};
      const lastProductId = error.lastUpdatedProductId ?? progress.lastUpdatedProductId;
      const lastImageId = error.lastUpdatedImageId ?? progress.lastUpdatedImageId;
      const processedItems = progress.processedItems ?? done;

      console.error("[Restore Worker Images] :error:", error?.response?.data || error.message);

      if (currentBatch?.length) {
        if (lastProductId != null && lastImageId != null) {
          markSucceededThrough(currentBatch, lastProductId, lastImageId, succeededImageKeys);
        }
        await deleteRestoredSnapshots({
          sourceJobId,
          itemData: currentBatch,
          target: "alt",
          failedImageKeys: buildFailedImageKeys(currentBatch, succeededImageKeys),
        });
      }

      await RestoreHistory.updateOne(
        { restoreJobId: job.id },
        { $set: { status: "failed", completedAt: new Date(), totalItems: total, processedItems } },
      );
      throw error;
    }

  },
  {
    connection: redis,
    concurrency: 1,
  },
);

module.exports = restoreWorker;
