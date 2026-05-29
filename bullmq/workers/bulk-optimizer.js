const dotenv = require("dotenv");
const { Worker } = require("bullmq");
const redis = require("../../redis");
const axios = require("axios");
const JobHistory = require("../../models/JobHistory");
const { default: mongoose } = require("mongoose");
const path = require("path");
dotenv.config({ path: path.resolve(__dirname, "../../.env") })

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("Workers: MongoDB connected"))
  .catch((err) => {
    console.error("Workers: MongoDB connection failed", err);
    process.exit(1);
  });

  const headers = (accessToken) => {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Auth-Token": accessToken,
    };
  }

  // ── Constants ──────────────────────────────────────────────
  const MAX_PER_PAGE    = 250;
  const CATEGORY_BATCH  = 50;
  const BRAND_PARALLEL_THRESHOLD = 25;
  const BRAND_PARALLEL_BATCH = 5;
  const NORMAL_THROTTLE_MS     = 300;
  const PRODUCT_BATCH_LIMIT = 10;


const listProductsUrl = (storeHash, include = "") => `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products${include ? `?include=${include}` : ""}`;
const batchUpdateUrl = (storeHash) => `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products`;
const listTreesUrl = (storeHash) => `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/trees`;
const listTreeCategoriesUrl = (storeHash) =>
  `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/trees/categories`;
const batchTreeCategoriesUrl = (storeHash) =>
  `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/trees/categories`;

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

async function fetchCategoriesForTrees(storeHash, treeIds, headers, maxPerPage) {
  if (treeIds.length === 0) return [];

  const categories = [];
  let page = 1;

  while (true) {
    const { data } = await axios.get(listTreeCategoriesUrl(storeHash), {
      headers,
      params: {
        page,
        limit: maxPerPage,
        "tree_id:in": treeIds.join(","),
      },
    });

    const batch = Array.isArray(data?.data) ? data.data : [];
    const totalPages = data?.meta?.pagination?.total_pages;
    categories.push(...batch);

    const isLastPage =
      batch.length === 0 ||
      (Number.isFinite(totalPages) && page >= totalPages) ||
      (!Number.isFinite(totalPages) && batch.length < maxPerPage);

    if (isLastPage) break;
    page += 1;
  }

  return categories;
}

const bulkOptimizerWorker = new Worker(
  "bulk-optimized-products",
  async (job) => {
    try {
      const { storeHash, target, template, accessToken, blanksOnly, bcChannelId } = job.data;

      console.log("[Product Worker] :started:", job.data);

      const renderTemplate = (input, product) => {
        const dict = {
          "[[product name]]": product?.name ?? "",
          "[[sku]]": product?.sku ?? "",
          "[[price]]":
            product?.price != null ? String(product.price) : "",
          "[[currency]]": product?.currency ?? "",
          "[[type]]": product?.type ?? "",
          "[[category name]]": "",
          "[[brand]]": product?.brand_name ?? "",
          "[[mpn]]": product?.mpn ?? "",
          "[[condition]]": product?.condition ?? "",
          "[[store name]]": "",
        };

        let out = String(input ?? "");
        for (const [token, value] of Object.entries(dict)) {
          out = out.replaceAll(token, value);
        }
        return out;
      };

      // Step 1: Fetch products
      let products = [];
      let page = 1;
      while (true) {
        console.log("[Product Worker] :Fetching products page:", page);
        const { data } = await axios.get((target === "alt" ? listProductsUrl(storeHash, "images") : listProductsUrl(storeHash)) , {
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

      const total = products.length;
      console.log("[Product Worker] :Total products fetched:", total);
      await job.updateProgress({ stage: "updating", done: 0, total });

      // Step 2: Filter out products that already have a title or meta description
      if(blanksOnly){ 
        if(target === "title" || target === "meta"){
          products = products.filter((p) => {
            if(target === "title" && p?.page_title !== "")return false;
            else if(target === "meta" && p?.meta_description !== "")return false;
            return true;
          });
        }
      }

      // Note: image alt text is on product images, not the product object.
      if (target === "alt") {
        const imageUpdates = [];
        for (const product of products) {
          if (!product.images || product.images.length === 0) continue;
          const altText = renderTemplate(template, product);
          for (const image of product.images) {
            if (!image.id) continue;
            if(blanksOnly && image.description !== "") continue;
            imageUpdates.push({
              productId: product.id,
              imageId: image.id,
              altText,
            });
          }
        }

        const totalImages = imageUpdates.length;
        let done = 0;

        for (let i = 0; i < imageUpdates.length; i += PRODUCT_BATCH_LIMIT) {
          const chunk = imageUpdates.slice(i, i + PRODUCT_BATCH_LIMIT);
          if (chunk.length === 0) continue;

          console.log(
            `Updating alt text ${i + 1}–${i + chunk.length} of ${totalImages}`,
          );

          const responses = await Promise.all(
            chunk.map(({ productId, imageId, altText }) =>
              fetch(
                `https://api.bigcommerce.com/stores/${storeHash}/v2/products/${productId}/images/${imageId}`,
                {
                  method: "PUT",
                  headers: headers(accessToken),
                  body: JSON.stringify({ description: altText }),
                },
              ),
            ),
          );

          for (const response of responses) {
            if (!response.ok) {
              const errBody = await response.text().catch(() => "");
              throw new Error(
                `Alt update failed (${response.status}): ${errBody}`,
              );
            }
          }

          done += chunk.length;
          await job.updateProgress({
            stage: "updating",
            done,
            total: totalImages,
          });

          let minRemaining = null;
          for (const response of responses) {
            const remaining = response.headers.get(
              "X-Rate-Limit-Requests-Left",
            );
            if (remaining != null) {
              const n = parseInt(remaining, 10);
              if (minRemaining == null || n < minRemaining) {
                minRemaining = n;
              }
            }
          }
          console.log(
            "rate limit remaining (batch min):",
            minRemaining ?? "unknown",
          );
          if (minRemaining != null && minRemaining < 50) {
            await new Promise((r) => setTimeout(r, 3000));
          } else {
            await new Promise((r) => setTimeout(r, 200));
          }
        }

        await job.updateProgress({
          stage: "done",
          done: totalImages,
          total: totalImages,
        });
        await JobHistory.updateOne(
          { jobId: job.id },
          {
            status: "done",
            completedAt: new Date(),
            totalItems: totalImages,
            processedItems: totalImages,
          },
        );
        console.log("[Product Worker] :done: products alt. job id: ", job.id);
        return;
      }

      // Step 3: Build batch update payloads (BigCommerce limit: 10 products per request)
      const updates = [];
      for (const product of products) {
        const productId = product?.id;
        if (!productId) continue;
        const rendered = renderTemplate(template, product);
        updates.push(
          target === "title"
            ? { id: productId, page_title: rendered }
            : { id: productId, meta_description: rendered },
        );
      }

      let done = 0;
      for (let i = 0; i < updates.length; i += PRODUCT_BATCH_LIMIT) {
        console.log("[Product Worker] :Updating products:", i, "of", updates.length, "job id:", job.id);
        const chunk = updates.slice(i, i + PRODUCT_BATCH_LIMIT);
        if (chunk.length === 0) continue;

        const response = await axios.put(batchUpdateUrl(storeHash), chunk, { headers: headers(accessToken) });
        done += chunk.length;

        await job.updateProgress({ stage: "updating", done, total });

        // Light throttling to avoid rate limiting
        const remaining = response.headers["x-rate-limit-requests-left"];
        console.log("[Product Worker] :Rate limit remaining:", remaining);
        if (remaining && parseInt(remaining) < 50) {
          await new Promise(r => setTimeout(r, 10*NORMAL_THROTTLE_MS));
        }else{
          await new Promise(r => setTimeout(r, 3*NORMAL_THROTTLE_MS));
        }
      }

      await job.updateProgress({ stage: "done", done: total, total });
      await JobHistory.updateOne(
        { jobId: job.id },
        {
          status: "done",
          completedAt: new Date(),
          totalItems: total,
          processedItems: done,
        },
      );
      console.log("[Product Worker] :done: products. job id: ", job.id);
    } catch (error) {
      console.error(error);
      await JobHistory.updateOne({ jobId: job.id }, { status: "failed", error: error.message });
      await job.updateProgress({ stage: "failed", done: 0, total: 0 });
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
      const { storeHash, target, template, accessToken, bcChannelId, blanksOnly } = job.data;

      if (bcChannelId == null || bcChannelId === "") {
        throw new Error("bcChannelId is required for category bulk updates");
      }

      console.log("bulkOptimizedCategoriesWorker started:", job.data);

      const batchUrl = batchTreeCategoriesUrl(storeHash);

      // ── Template renderer ──────────────────────────────────────
      const renderTemplate = (template, category) => {
        const tokens = {
          "[[category name]]": category?.name ?? "",
        };

        let out = template || "";
        for (const [token, value] of Object.entries(tokens)) {
          out = out.replaceAll(token, value);
        }
        return out;
      };

      // ── Step 1: Resolve category tree(s) for the channel ───────
      const treeIds = await fetchTreeIdsForChannel(
        storeHash,
        bcChannelId,
        headers(accessToken),
      );

      if (treeIds.length === 0) {
        console.log("[Category Worker] :No category trees found for channel");
        await job.updateProgress({
          stage: "done",
          resource: "categories",
          done: 0,
          total: 0,
          note: "No category trees found for channel",
        });
        await JobHistory.updateOne(
          { jobId: job.id },
          {
            status: "done",
            completedAt: new Date(),
            totalItems: 0,
            processedItems: 0,
          },
        );
        return;
      }

      // ── Step 2: Fetch categories for those tree(s) ─────────────
      let categories = await fetchCategoriesForTrees(
        storeHash,
        treeIds,
        headers(accessToken),
        MAX_PER_PAGE,
      );
      
      // Step 3: Filter out categories that already have a title or meta description
      if(blanksOnly){
        categories = categories.filter((c) => {
          if(target === "title" && c?.page_title !== "")return false;
          else if(target === "meta" && c?.meta_description !== "")return false;
          return true;
        });
      }

      const total = categories.length;
      console.log(`[Category Worker] :Total categories fetched for channel ${bcChannelId}: ${total}`);

      await job.updateProgress({ stage: "fetched", resource: "categories", total });

      // ── Step 4: Build update payloads ──────────────────────────
      const updates = categories
        .filter((c) => c?.category_id)
        .map((category) => ({
          category_id: category.category_id,
          ...(target === "title"
            ? { page_title: renderTemplate(template, category) }
            : { meta_description: renderTemplate(template, category) }),
        }));

      console.log("updates:::::::::::::::::::::::::::::::::::::", updates);

      // ── Step 5: Batch PUT in chunks of 50 ─────────────────────
      let done = 0;

      for (let i = 0; i < updates.length; i += CATEGORY_BATCH) {
        const chunk = updates.slice(i, i + CATEGORY_BATCH);

        console.log(`Updating categories ${i + 1}–${i + chunk.length} of ${total}`);

        await axios.put(batchUrl, chunk, { headers: headers(accessToken) });

        done += chunk.length;
        await job.updateProgress({ stage: "updating", resource: "categories", done, total });

        // Light throttling to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, NORMAL_THROTTLE_MS));
      }

      await job.updateProgress({ stage: "done", resource: "categories", done: total, total });
      await JobHistory.updateOne(
        { jobId: job.id },
        {
          status: "done",
          completedAt: new Date(),
          totalItems: total,
          processedItems: done,
        },
      );
      console.log("[Category Worker] :Categories bulk update complete.");

    } catch (error) {
      console.error("[Category Worker] :error:", error?.response?.data || error.message);
      await JobHistory.updateOne({ jobId: job.id }, { status: "failed", error: error.message });
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
      const { storeHash, target, template, accessToken, blanksOnly } = job.data;

      const renderTemplate = (template, brand) => {
        const tokens = {
          "[[name]]": brand?.name ?? "",
        };
        let out = template || "";
        for (const [token, value] of Object.entries(tokens)) {
          out = out.replaceAll(token, value);
        }
        return out;
      };

      const listBrandsUrl = (storeHash) =>
        `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/brands`;
      const updateBrandUrl = (storeHash, brandId) =>
        `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/brands/${brandId}`;

      const brands = [];
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

      await job.updateProgress({ stage: "fetched", resource: "brands", total: brands.length });

      let payload = brands
        .filter((b) => b?.id && b?.name)
        .map((brand) => ({
          id: brand.id,
          name: brand.name,
          ...(target === "title" ? { page_title: renderTemplate(template, brand) } : { meta_description: renderTemplate(template, brand) }),
        }));

      if (blanksOnly) {
        payload = payload.filter((p) => {
          if (target === "title" && p?.page_title !== "") return false;
          else if (target === "meta" && p?.meta_description !== "") return false;
          return true;
        });
      }

      const totalToUpdate = payload.length;

      if (totalToUpdate === 0) {
        await job.updateProgress({ stage: "done", resource: "brands", done: 0, total: 0 });
        await JobHistory.updateOne(
          { jobId: job.id },
          { status: "done", completedAt: new Date(), totalItems: 0, processedItems: 0 },
        );
        console.log("[Brand Worker] :No brands to update.");
        return;
      }

      const putBrand = (item) => {
        const { id, name, page_title, meta_description } = item;
        const body = { name };
        if (page_title !== undefined) body.page_title = page_title;
        if (meta_description !== undefined) body.meta_description = meta_description;
        return axios.put(updateBrandUrl(storeHash, id), body, {
          headers: headers(accessToken),
        });
      };

      let done = 0;

      if (totalToUpdate >= BRAND_PARALLEL_THRESHOLD) {
        for (let i = 0; i < payload.length; i += BRAND_PARALLEL_BATCH) {
          const chunk = payload.slice(i, i + BRAND_PARALLEL_BATCH);
          console.log(
            `[Brand Worker] Updating brands ${i + 1}–${i + chunk.length} of ${totalToUpdate} (batch of ${BRAND_PARALLEL_BATCH})`,
          );

          await Promise.all(chunk.map((item) => putBrand(item)));

          done += chunk.length;
          await job.updateProgress({
            stage: "updating",
            resource: "brands",
            done,
            total: totalToUpdate,
          });

          //2x throttle for parallel updates in batches to avoid rate limiting
          await new Promise((resolve) => setTimeout(resolve, 2*NORMAL_THROTTLE_MS));
        }
      } else {
        for (const item of payload) {
          console.log("[Brand Worker] :Updating brand:", item.id, "job id:", job.id);
          await putBrand(item);
          done += 1;
          await job.updateProgress({
            stage: "updating",
            resource: "brands",
            done,
            total: totalToUpdate,
          });

          await new Promise((resolve) => setTimeout(resolve, NORMAL_THROTTLE_MS));
        }
      }

      await job.updateProgress({
        stage: "done",
        resource: "brands",
        done: totalToUpdate,
        total: totalToUpdate,
      });
      const updatedJob = await JobHistory.updateOne(
        { jobId: job.id },
        {
          status: "done",
          completedAt: new Date(),
          totalItems: totalToUpdate,
          processedItems: done,
        },
      );
      console.log("[Brand Worker] :Brands bulk update complete.",job.id, "updated job:", updatedJob);
    } catch (error) {
      console.error("[Brand Worker] :error:", error?.response?.data || error.message);
      await JobHistory.updateOne(
        { jobId: job.id },
        { status: "failed", error: error.message },
      );
      throw error;
    }
  },
  { 
     connection: redis, 
     concurrency: 2,
   },
);

module.exports = {
  batchTreeCategoriesUrl,
  batchUpdateUrl,
};