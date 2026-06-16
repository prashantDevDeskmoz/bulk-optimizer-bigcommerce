const { Worker } = require("bullmq");
const redis = require("../../redis");
const ItemSnapshot = require("../../models/ItemSnapshot");
const axios = require("axios");
const JobHistory = require("../../models/JobHistory");
const { updateBulkProducts, updateBulkCategories, updateBulkBrands } = require("../workerService");
const { updateImageUrl } = require("../../utils/bcApi");

  const PRODUCT_BATCH_LIMIT = 10;
  const NORMAL_THROTTLE_MS = 300;
  const CATEGORY_BATCH = 50;
  const BRAND_PARALLEL_THRESHOLD = 25;
  const BRAND_PARALLEL_BATCH = 5;

  const headers = (accessToken) => {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Auth-Token": accessToken,
    };
  }

const restoreWorker = new Worker(
  "bulk-restore",
  async (job) => {
    try {
      const { jobId, accessToken, storeHash } = job.data;

      if (!jobId) {
        throw new Error("jobId is required for restore jobs");
      }

      const jobHistory = await JobHistory.findOne({ jobId });
      if (!jobHistory) {
        throw new Error(`Job history not found for job ${jobId}`);
      }

      if(jobHistory.status !== "completed") {
        throw new Error(`Job ${jobId} is not completed yet`);
      }

      const itemData = await ItemSnapshot.find({ jobHistoryId: jobId, is_restored: false });
      
      if (!itemData || itemData.length === 0) {
        throw new Error(`No items found for job ${jobId}`);
      }

      const total = itemData.length;

      const updatablePayload = [];
      for (const item of itemData) {
        updatablePayload.push({
          [jobHistory.resource === "categories" ? "category_id" : "id"]: item.itemId,
          ...(jobHistory.target === "title" && { page_title: item.fields.page_title }),
          ...(jobHistory.target === "meta" && { meta_description: item.fields.meta_description }),
        });
      }
    
      let done = 0;

      if(jobHistory.target === "alt") {

        let imageUpdates = [];
        for (const item of itemData) {
          for (const field of item.fields.images) {
            imageUpdates.push({
              productId: item.itemId,
              imageId: field.imageId,
              alt_text: field.altText,
            })
          }
        }

        for (let i = 0; i < imageUpdates.length; i += PRODUCT_BATCH_LIMIT) {
          const chunk = imageUpdates.slice(i, i + PRODUCT_BATCH_LIMIT);
          if (chunk.length === 0) continue;

          console.log(
            `Updating alt text ${i + 1}–${i + chunk.length} of ${imageUpdates.length}`,
          );

          const responses = await Promise.all(
            chunk.map(({ productId, imageId, alt_text }) =>
              axios.put(updateImageUrl(storeHash, productId, imageId), { description: alt_text }, { headers: headers(accessToken) }),
            ),
          );

          for (const response of responses) {
            if (!response.status === 200) {
              console.log("alt update failed:::::::::::::::::::::::::::::::::::::", response.data);
            }else{
              done += 1;
              remaining = response.headers["x-rate-limit-requests-left"];
            }
          }
          if(remaining < 50){
            await new Promise((r) => setTimeout(r, 3*NORMAL_THROTTLE_MS));
          }else{
            await new Promise((r) => setTimeout(r, NORMAL_THROTTLE_MS));
          }

        }
      }else if(jobHistory.resource === "products") {
        done = await updateBulkProducts({ storeHash, updatablePayload, done, NORMAL_THROTTLE_MS, PRODUCT_BATCH_LIMIT, accessToken, job});
        await job.updateProgress({ stage: "restored", done: done.done, total: total });
      }else if(jobHistory.resource === "categories") {
        done = await updateBulkCategories({ storeHash, updatablePayload, done, NORMAL_THROTTLE_MS, CATEGORY_BATCH, accessToken, job});
        await job.updateProgress({ stage: "restored", done: done.done, total: total });
      }else if(jobHistory.resource === "brands") {
        done = await updateBulkBrands({ storeHash, updatablePayload, done, NORMAL_THROTTLE_MS, BRAND_PARALLEL_THRESHOLD, BRAND_PARALLEL_BATCH, accessToken, job});
        await job.updateProgress({ stage: "restored", done: done.done, total: total });
      }else{
        throw new Error(`Invalid type of items ${jobHistory.resource}`);
      }

      console.log("total,done:::::::::::::::::::::::::::::::::::::", total, done.done || done);

      await ItemSnapshot.updateMany({ jobHistoryId: jobId }, { $set: { is_restored: true } });
      await JobHistory.updateOne({ jobId }, { $set: { restoreStatus: "completed" } });
    } catch (error) {
      console.error("[Restore Worker] :error:", error?.response?.data || error.message);
      await JobHistory.updateOne({ jobId }, { $set: { restoreStatus: "failed" } });
      throw error;
    }
  },
  {
    connection: redis,
    concurrency: 2,
  },
);