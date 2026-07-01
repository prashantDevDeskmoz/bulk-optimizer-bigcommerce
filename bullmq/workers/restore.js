const { Worker } = require("bullmq");
const redis = require("../../redis");
const ItemSnapshot = require("../../models/ItemSnapshot");
const axios = require("axios");
const JobHistory = require("../../models/JobHistory");
const RestoreHistory = require("../../models/RestoreHistory");
const { updateBulkProducts, updateBulkCategories, updateBulkBrands, PRODUCT_BATCH_LIMIT, NORMAL_THROTTLE_MS, RATE_LIMIT_LOW_THRESHOLD } = require("../workerService");
const { updateImageUrl } = require("../../utils/bcApi");

const headers = (accessToken) => {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Auth-Token": accessToken,
  };
};

const deleteRestoredSnapshots = async ({
  sourceJobId,
  itemData,
  target,
  failedIds = [],
  failedImageKeys = new Set(),
}) => {
  if (target === "alt") {
    for (const item of itemData) {
      const images = item.fields?.images ?? [];
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
    }
    return;
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

const restoreWorker = new Worker(
  "bulk-restore",
  async (job) => {
    const { sourceJobId: sourceJobIdFromData, jobId: legacyJobId, accessToken, storeHash } = job.data;
    const sourceJobId = sourceJobIdFromData || legacyJobId;

    try {
      if (!sourceJobId) {
        throw new Error("sourceJobId is required for restore jobs");
      }

      const restoreHistory = await RestoreHistory.findOne({ restoreJobId: job.id });
      if (!restoreHistory) {
        throw new Error(`Restore history not found for job ${job.id}`);
      }

      const jobHistory = await JobHistory.findOne({ jobId: sourceJobId });
      if (!jobHistory) {
        throw new Error(`Job history not found for job ${sourceJobId}`);
      }

      if (jobHistory.status !== "completed") {
        throw new Error(`Job ${sourceJobId} is not completed yet`);
      }

      const itemData = await ItemSnapshot.find({ jobHistoryId: sourceJobId });

      if (!itemData || itemData.length === 0) {
        throw new Error(`No items found for job ${sourceJobId}`);
      }

      const total = itemData.length;
      await RestoreHistory.updateOne(
        { restoreJobId: job.id },
        { $set: { totalItems: total, processedItems: 0 } },
      );

      const updatablePayload = [];
      for (const item of itemData) {
        updatablePayload.push({
          [jobHistory.resource === "categories" ? "category_id" : "id"]: item.itemId,
          ...(jobHistory.target === "title" && { page_title: item.fields.page_title }),
          ...(jobHistory.target === "meta" && { meta_description: item.fields.meta_description }),
        });
      }

      let done = 0;
      let failedIds = [];
      const failedImageKeys = new Set();

      if (jobHistory.target === "alt") {
        const imageUpdates = [];
        for (const item of itemData) {
          for (const field of item.fields.images) {
            imageUpdates.push({
              productId: item.itemId,
              imageId: field.imageId,
              alt_text: field.altText,
            });
          }
        }

        await RestoreHistory.updateOne(
          { restoreJobId: job.id },
          { $set: { totalItems: imageUpdates.length } },
        );

        let remaining = Infinity;

        for (let i = 0; i < imageUpdates.length; i += PRODUCT_BATCH_LIMIT) {
          const chunk = imageUpdates.slice(i, i + PRODUCT_BATCH_LIMIT);
          if (chunk.length === 0) continue;

          console.log(
            `Updating alt text ${i + 1}–${i + chunk.length} of ${imageUpdates.length}`,
          );

          const results = await Promise.allSettled(
            chunk.map(({ productId, imageId, alt_text }) =>
              axios.put(
                updateImageUrl(storeHash, productId, imageId),
                { description: alt_text },
                { headers: headers(accessToken) },
              ),
            ),
          );

          const failedEntries = [];
          for (let j = 0; j < results.length; j++) {
            const result = results[j];
            const { productId, imageId } = chunk[j];
            if (result.status === "fulfilled" && result.value.status === 200) {
              done += 1;
              remaining = result.value.headers["x-rate-limit-requests-left"];
            } else {
              const message =
                result.status === "rejected"
                  ? JSON.stringify(result.reason?.response?.data ?? result.reason?.message)
                  : JSON.stringify(result.value?.data);
              console.log("alt update failed:::::::::::::::::::::::::::::::::::::", message);
              failedEntries.push({ itemId: productId, imageId, message });
              failedImageKeys.add(`${productId}-${imageId}`);
            }
          }

          if (failedEntries.length > 0) {
            await RestoreHistory.updateOne(
              { restoreJobId: job.id },
              { $push: { errorLog: { $each: failedEntries } } },
            );
          }

          await RestoreHistory.updateOne(
            { restoreJobId: job.id },
            { $set: { processedItems: done } },
          );
          await job.updateProgress({ stage: "restored", processedItems: done, totalItems: imageUpdates.length });

          if (remaining < RATE_LIMIT_LOW_THRESHOLD) {
            await new Promise((r) => setTimeout(r, 3 * NORMAL_THROTTLE_MS));
          } else {
            await new Promise((r) => setTimeout(r, NORMAL_THROTTLE_MS));
          }
        }
      } else if (jobHistory.resource === "products") {
        const result = await updateBulkProducts({
          storeHash,
          updatablePayload,
          done,
          accessToken,
          job,
          type: "restore",
        });
        done = result.done;
        failedIds = result.failedIds ?? [];
        await RestoreHistory.updateOne(
          { restoreJobId: job.id },
          { $set: { processedItems: done } },
        );
        await job.updateProgress({ stage: "restored", done, total });
      } else if (jobHistory.resource === "categories") {
        const result = await updateBulkCategories({
          storeHash,
          updatablePayload,
          done,
          accessToken,
          job,
          type: "restore",
        });
        done = result.done;
        failedIds = result.failedIds ?? [];
        await RestoreHistory.updateOne(
          { restoreJobId: job.id },
          { $set: { processedItems: done } },
        );
        await job.updateProgress({ stage: "restored", done, total });
      } else if (jobHistory.resource === "brands") {
        const result = await updateBulkBrands({
          storeHash,
          updatablePayload,
          done,
          accessToken,
          job,
          type: "restore",
        });
        done = result.done;
        failedIds = result.failedIds ?? [];
        await RestoreHistory.updateOne(
          { restoreJobId: job.id },
          { $set: { processedItems: done } },
        );
        await job.updateProgress({ stage: "restored", done, total });
      } else {
        throw new Error(`Invalid type of items ${jobHistory.resource}`);
      }

      console.log("total,done:::::::::::::::::::::::::::::::::::::", total, done);

      await deleteRestoredSnapshots({
        sourceJobId,
        itemData,
        target: jobHistory.target,
        failedIds,
        failedImageKeys,
      });
      await RestoreHistory.updateOne(
        { restoreJobId: job.id },
        { $set: { status: "completed", completedAt: new Date(), processedItems: done } },
      );
    } catch (error) {
      const progress = job.progress
      console.error("[Restore Worker] :error:", error?.response?.data || error.message);
      await RestoreHistory.updateOne(
        { restoreJobId: job.id },
        { $set: { status: "failed", completedAt: new Date(), totalItems: progress.totalItems, processedItems: progress.processedItems } },
      );
      throw error;
    }
  },
  {
    connection: redis,
    concurrency: 2,
  },
);

module.exports = restoreWorker;
