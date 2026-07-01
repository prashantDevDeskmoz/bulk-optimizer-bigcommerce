const { Worker } = require("bullmq");
const redis = require("../../redis");
const axios = require("axios");
const JobHistory = require("../../models/JobHistory");
const ItemSnapshot = require("../../models/ItemSnapshot");
const { updateSnapshotAndReturnUpdatablePayload, updateBulkCategories, updateBulkBrands, updateBulkProducts, updateBulkImageAltText, MAX_PER_PAGE } = require("../workerService");
const {
  listProductsUrl,
  listTreesUrl,
  listTreeCategoriesUrl,
  listBrandsUrl,
  updateBrandUrl,
  updateImageUrl,
} = require("../../utils/bcApi");

  const headers = (accessToken) => {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Auth-Token": accessToken,
    };
  }

async function fetchTreeIdsForChannel(storeHash, bcChannelId, headers) {
  const { data } = await axios.get(listTreesUrl(storeHash), {
    headers,
    params: { "channel_id:in": bcChannelId },
  });

  const trees = Array.isArray(data?.data) ? data.data : [];
  return trees
    .map((tree) => tree?.id)
    .filter((id) => id != null && id !== "");
}

async function fetchCategoriesForTrees(storeHash, treeIds, headers) {
  if (treeIds.length === 0) return [];

  const categories = [];
  let page = 1;

  while (true) {
    const { data } = await axios.get(listTreeCategoriesUrl(storeHash), {
      headers,
      params: {
        page,
        limit: MAX_PER_PAGE,
        "tree_id:in": treeIds.join(","),
      },
    });

    const batch = Array.isArray(data?.data) ? data.data : [];
    const totalPages = data?.meta?.pagination?.total_pages;
    categories.push(...batch);

    const isLastPage =
      batch.length === 0 ||
      (Number.isFinite(totalPages) && page >= totalPages) ||
      (!Number.isFinite(totalPages) && batch.length < MAX_PER_PAGE);

    if (isLastPage) break;
    page += 1;
  }

  return categories;
}

async function fetchProductsForChannel(storeHash, accessToken, bcChannelId, { includeImages = false } = {}) {
  let products = [];
  let page = 1;

  while (true) {
    const { data } = await axios.get(
      includeImages ? listProductsUrl(storeHash, "images") : listProductsUrl(storeHash),
      {
        headers: headers(accessToken),
        params: { page, limit: MAX_PER_PAGE, "channel_id:in": bcChannelId },
      },
    );

    const batch = Array.isArray(data?.data) ? data.data : [];
    products.push(...batch);

    const totalPages = data?.meta?.pagination?.total_pages;
    if (batch.length === 0) break;
    if (Number.isFinite(totalPages) && page >= totalPages) break;
    if (!Number.isFinite(totalPages) && batch.length < MAX_PER_PAGE) break;
    page += 1;
  }

  return products;
}

function filterProductsForAlt(products) {
  return products
    .filter((p) => p?.id)
    .filter((p) => !/\[sample\]/i.test(p.name ?? ""))
    .filter((p) => p.images?.length > 0);
}

const bulkOptimizerWorker = new Worker(
  "bulk-optimized-products",
  async (job) => {
    try {
      const { storeHash, target, template, accessToken, blanksOnly, bcChannelId, canBeUpdated } = job.data;

      console.log("[Product Worker] :started:", job.data);

      // Step 1: Fetch products
      let products = [];
      let page = 1; 
      while (true) {
        console.log("[Product Worker] :Fetching products page:", page);
        const { data } = await axios.get(listProductsUrl(storeHash) , {
          headers: headers(accessToken),
          params: { page, limit: MAX_PER_PAGE, "channel_id:in": bcChannelId },
        });

        const batch = Array.isArray(data?.data) ? data.data : [];
        products.push(...batch);

        const totalPages = data?.meta?.pagination?.total_pages;
        if (batch.length === 0) break;
        if (Number.isFinite(totalPages) && page >= totalPages) break;
        if (!Number.isFinite(totalPages) && batch.length < MAX_PER_PAGE) break;
        page += 1;
      }

      console.log("[Product Worker] :Total products fetched:", products.length);
            

      // Step 2: Filter out products that already have a title or meta description
      products = products.filter((p) => p?.id);
      if(blanksOnly){ 
          products = products.filter((p) => {
            if(target === "title" && p?.page_title !== "")return false;
            else if(target === "meta" && p?.meta_description !== "")return false;
            return true;
        });
      }
      

      const total = products.length;

      // Step 3: Only update max of canBeUpdated products, if canBeUpdated is less than products.length, then update all of them
      if(canBeUpdated !== undefined && canBeUpdated !== null){
          products = products.slice(0, canBeUpdated);
      }
      await job.updateProgress({ status: "updating", processedItems: 0, totalItems: total });   

      const {updatablePayload , bulkOperations} = await updateSnapshotAndReturnUpdatablePayload({storeHash, itemType: "product", items: products, target, jobId: job.id, bcChannelId, template});

      // Step 4: Build batch update payloads (BigCommerce limit: 10 products per request)

      let done = 0;
      const { done: updatedDone } = await updateBulkProducts({ storeHash, updatablePayload, done, accessToken, job, bulkOperations});

      await job.updateProgress({ status: "completed", processedItems: updatedDone, totalItems: total });
      await JobHistory.updateOne(
        { jobId: job.id },
        { status: "completed", completedAt: new Date(), totalItems: total, processedItems: updatedDone },
      );
      console.log("[Product Worker] :done: products. job id: ", job.id);
    } catch (error) {
      console.error(error);
      const progress = job.progress;
      await job.updateProgress({ ...progress, status: "failed" });
      await JobHistory.updateOne({ jobId: job.id }, { status: "failed", error: error.message, totalItems: progress?.totalItems ?? 0, processedItems: progress?.processedItems ?? 0 });
      throw error;
    }
  },
  {
     connection: redis ,
     concurrency: 2,
  },
);

const bulkOptimizedCategoriesWorker = new Worker(
  "bulk-optimized-categories",
  async (job) => {
    try {
      const { storeHash, target, template, accessToken, bcChannelId, blanksOnly, canBeUpdated } = job.data;

      if (bcChannelId == null || bcChannelId === "") {
        throw new Error("bcChannelId is required for category bulk updates");
      }

      console.log("bulkOptimizedCategoriesWorker started:", job.data);

      // ── Step 1: get tree ids for channel ───────
      const treeIds = await fetchTreeIdsForChannel(
        storeHash,
        bcChannelId,
        headers(accessToken),
      );

      // if no tree ids found, return
      if (treeIds.length === 0) {
        console.log("[Category Worker] :No category trees found for channel");
        await job.updateProgress({
          status: "completed",
          resource: "categories",
          processedItems: 0,
          totalItems: 0,
          note: "No category trees found for channel",
        });
        await JobHistory.updateOne(
          { jobId: job.id },
          {
            status: "completed",
            completedAt: new Date(),
            totalItems: 0,
            processedItems: 0,
          },
        );
        return;
      }

      // ── Step 2: Fetch categories for those tree ids ─────────────
      let categories = await fetchCategoriesForTrees(
        storeHash,
        treeIds,
        headers(accessToken),
      );
      
      // Step 3: Filter out categories that already have a title or meta description
      categories = categories.filter((c) => c?.category_id);
      if(blanksOnly){
        categories = categories.filter((c) => {
          if(target === "title" && c?.page_title !== "")return false;
          else if(target === "meta" && c?.meta_description !== "")return false;
          return true;
        });
      }

      const total = categories.length;
      console.log(`[Category Worker] :Total categories fetched for channel ${bcChannelId}: ${total}`);

      await job.updateProgress({ status: "updating", resource: "categories", totalItems: total });
      
      // Step 5: Only update max of canBeUpdated categories, if canBeUpdated is greater than categories.length, then update all of them
      if(canBeUpdated !== undefined && canBeUpdated !== null){
        categories = categories.slice(0, canBeUpdated);
      }
      
      // Step 6: get payload to update and update snapshots for restore functionality
      const {updatablePayload, bulkOperations} = await updateSnapshotAndReturnUpdatablePayload({storeHash, itemType: "category", items: categories, target, jobId: job.id, template, bcChannelId});

      // ── Step 7: Batch PUT in chunks of 50 ─────────────────────
      let done = 0;  

      const { done: updatedDone, updatedBulkOperations } = await updateBulkCategories({ storeHash, updatablePayload, done, accessToken, job, bulkOperations});

      await job.updateProgress({ status: "completed", resource: "categories", processedItems: updatedDone, totalItems: total });
      await JobHistory.updateOne(
        { jobId: job.id },
        {
          status: "completed",
          completedAt: new Date(),
          totalItems: total,
          processedItems: updatedDone,
        },
      );
      console.log("[Category Worker] :Categories bulk update complete.");

    } catch (error) {
      const progress = job.progress;
      await job.updateProgress({ ...progress, status: "failed" });
      await JobHistory.updateOne({ jobId: job.id }, { status: "failed", error: error.message, totalItems: progress?.totalItems ?? 0, processedItems: progress?.processedItems ?? 0 });
      console.error("[Category Worker] :error:", error?.response?.data || error.message);
      throw error;
    }
  },
  { 
     connection: redis ,
     concurrency: 2,
  },
);

const bulkOptimizedBrandsWorker = new Worker(
  "bulk-optimized-brands",
  async (job) => {
    try {
      const { storeHash, target, template, accessToken, blanksOnly, canBeUpdated } = job.data;

      let brands = [];
      let page = 1;
      while (true) {
        console.log("[Brand Worker] :Fetching brands page:", page);
        const { data } = await axios.get(listBrandsUrl(storeHash), {
          headers: headers(accessToken),
          params: { page, limit: MAX_PER_PAGE },
        });
        const batch = Array.isArray(data?.data) ? data.data : [];
        brands.push(...batch);
        const totalPages = data?.meta?.pagination?.total_pages;
        if (batch.length === 0) break;
        if (Number.isFinite(totalPages) && page >= totalPages) break;
        if (!Number.isFinite(totalPages) && batch.length < MAX_PER_PAGE) break;

        page += 1;
      }

      await job.updateProgress({ status: "updating", resource: "brands", totalItems: brands.length });

      brands = brands.filter((b) => b?.id && b?.name);
      if (blanksOnly) {
        brands = brands.filter((p) => {
          if (target === "title" && p?.page_title !== "") return false;
          else if (target === "meta" && p?.meta_description !== "") return false;
          return true;
        });
      }

      const total = brands.length;

      if (total === 0) {
        await job.updateProgress({ status: "completed", resource: "brands", processedItems: 0, totalItems: 0 });
        await JobHistory.updateOne(
          { jobId: job.id },
          { status: "completed", completedAt: new Date(), totalItems: 0, processedItems: 0 },
        );
        console.log("[Brand Worker] :No brands to update.");
        return;
      }

      // Only update max of canBeUpdated brands, if canBeUpdated is less than payload.length, then update all of them
      if(canBeUpdated !== undefined && canBeUpdated !== null){
        brands = brands.slice(0, canBeUpdated);
      }

      const {updatablePayload, bulkOperations} = await updateSnapshotAndReturnUpdatablePayload({storeHash, itemType: "brand", items: brands, target, jobId: job.id, template});

      let done = 0;

      const { done: updatedDone } = await updateBulkBrands({ storeHash, updatablePayload, done, accessToken, job, bulkOperations});

      await job.updateProgress({
        status: "completed",
        resource: "brands",
        processedItems: updatedDone,
        totalItems: total,
      });
      const updatedJob = await JobHistory.updateOne(
        { jobId: job.id },
        {
          status: "completed",
          completedAt: new Date(),
          totalItems: total,
          processedItems: updatedDone,
        },
      );
      console.log("[Brand Worker] :Brands bulk update complete.",job.id, "updated job:", updatedJob);
    } catch (error) {
      console.error("[Brand Worker] :error:", error?.response?.data || error.message);
      const progress = job.progress;
      await job.updateProgress({ ...progress, status: "failed" });
      await JobHistory.updateOne(
        { jobId: job.id },
        { status: "failed", error: error.message, totalItems: progress?.totalItems ?? 0, processedItems: progress?.processedItems ?? 0 },
      );
      throw error;
    }
  },
  { 
     connection: redis, 
     concurrency: 2,
   },
);

const bulkOptimizedImagesWorker = new Worker(
  "bulk-optimized-images",
  async (job) => {
    try {
      const { storeHash, template, accessToken, blanksOnly, canBeUpdated, bcChannelId } = job.data;

      console.log("[Image Worker] :started:", job.data);

      console.log("[Image Worker] :Fetching products with images...");
      let products = await fetchProductsForChannel(storeHash, accessToken, bcChannelId, {includeImages: true});

      console.log("[Image Worker] :Total products fetched:", products.length);

      products = filterProductsForAlt(products);

      const {updatablePayload, bulkOperations} = await updateSnapshotAndReturnUpdatablePayload({storeHash, itemType: "product", items: products, target: "alt", jobId: job.id, template, bcChannelId});

      let done = 0;
      const { done: updatedDone, updatedBulkOperations, totalImages } = await updateBulkImageAltText({ storeHash, canBeUpdated, blanksOnly, updatablePayload, done, accessToken, job, bulkOperations});

      await job.updateProgress({ status: "completed", resource: "products", processedItems: updatedDone, totalItems: totalImages });
      await JobHistory.updateOne({ jobId: job.id }, { status: "completed", completedAt: new Date(), totalItems: totalImages, processedItems: updatedDone });
      console.log("[Image Worker] :done: job id:", job.id, totalImages);
    } catch (error) {
      let progress = job.progress;
      console.error("[Image Worker] :error:", error?.response?.data || error.message);
      await JobHistory.updateOne({ jobId: job.id }, { status: "failed", error: error.message, totalItems: progress?.totalItems ?? 0, processedItems: progress?.processedItems ?? 0 });
      await job.updateProgress({ ...progress, status: "failed" });
      throw error;
    }
  },
  {
    connection: redis,
    concurrency: 1,
  },
);
