const ItemSnapshot = require("../models/ItemSnapshot");
const axios = require("axios");
const { batchUpdateCategoriesUrl, batchUpdateProductsUrl, updateBrandUrl, updateImageUrl } = require("../utils/bcApi");
const JobHistory = require("../models/JobHistory");
const RestoreHistory = require("../models/RestoreHistory");

const MAX_RETRIES = 2;
const MAX_PER_PAGE = 250;
const CATEGORY_BATCH = 50;
const BRAND_PARALLEL_THRESHOLD = 25;
const BRAND_PARALLEL_BATCH = 5;
const NORMAL_THROTTLE_MS = 300;
const PRODUCT_BATCH_LIMIT = 10;
const RATE_LIMIT_LOW_THRESHOLD = 50;

const headers = (accessToken) => {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Auth-Token": accessToken,
    };
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const pushItemErrorLog = async ({ job, type, entries }) => {
    const normalized = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
    if (normalized.length === 0) return;
    if (type === "bulk") {
      await JobHistory.updateOne(
        { jobId: job.id },
        { $push: { errorLog: { $each: normalized } } },
      );
    } else if (type === "restore") {
      await RestoreHistory.updateOne(
        { restoreJobId: job.id },
        { $push: { errorLog: { $each: normalized } } },
      );
    }
  };

  const putWithRetry = async (url, payload, headers, retries = MAX_RETRIES) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios.put(url, payload, { headers });
            return response;
        } catch (error) {
            const status = error?.response?.status;
            // Network error or no response (timeout, connection reset, etc.)
            if (!status) {
                if (attempt === retries) throw error;
                const backoff = Math.min(1000 * 2 ** attempt + Math.random() * 500, 30000);
                console.warn(`[Retry] Network error, attempt ${attempt}/${retries}. Waiting ${backoff}ms`);
                await sleep(backoff);
                continue;
            }
            // Rate limited — respect the reset header
            if (status === 429) {
                const resetMs =
                    parseInt(error.response.headers["x-rate-limit-time-reset-ms"] ?? 0) ||
                    parseInt(error.response.headers["x-retry-after"] ?? 0) * 1000;
                const waitMs = resetMs || 5000;
                console.warn(`[Retry] 429 Rate limited. Waiting ${waitMs}ms before retry ${attempt}/${retries}`);
                await sleep(waitMs);
                continue;
            }
            // Transient server errors — exponential backoff
            if ([500, 502, 503, 504].includes(status)) {
                if (attempt === retries) throw error;
                const backoff = Math.min(1000 * 2 ** attempt + Math.random() * 500, 30000);
                console.warn(`[Retry] ${status} server error, attempt ${attempt}/${retries}. Waiting ${backoff}ms`);
                await sleep(backoff);
                continue;
            }
            // Non-retryable errors (422, 404, 409, 501, etc.) — throw immediately
            throw error;
        }
    }
};

const saveSnapshot = async ({ lastUpdatedId, failedIds, bulkOperations, slice = true }) => {

    let updatedBulkOperations = [...bulkOperations] //clone the bulk operations
    // slice to lastUpdatedId if slice is true (means the job is failed and is giving error mid loop)
    if (slice) {
        if (lastUpdatedId == null) {
            updatedBulkOperations = [];
        }else{

            const lastUpdatedIndex = bulkOperations.findIndex(operation => operation?.updateOne?.filter?.itemId === lastUpdatedId) + 1
            || bulkOperations.findIndex(operation => operation?.insertOne?.document?.itemId === lastUpdatedId) + 1

            updatedBulkOperations = bulkOperations.slice(0, lastUpdatedIndex);
        }
    }

    // filter out failed ids
    updatedBulkOperations = updatedBulkOperations.filter(operation =>
        !failedIds.includes(operation.updateOne?.filter?.itemId)
        && !failedIds.includes(operation.insertOne?.document?.itemId)
    );

    if (updatedBulkOperations.length > 0) {
        console.log(`[Snapshot] Writing ${updatedBulkOperations.length}, lastUpdatedId: ${lastUpdatedId}, failedIds: ${failedIds}, slice: ${slice}, operations to ItemSnapshot`);
        await ItemSnapshot.bulkWrite(updatedBulkOperations);
    }
    return updatedBulkOperations;
};

const saveImageSnapshot = async ({ lastUpdatedImageId, lastUpdatedProductId, failedImages, bulkOperations, slice = true }) => {
    const failedImageIds = new Set(failedImages.map((f) => f.imageId));
    const filterSnapshotImages = (images) =>
        (images ?? []).filter((img) => !failedImageIds.has(img.imageId));
    const hasFailedImagesForProduct = (productId) =>
        failedImages.some((f) => f.itemId === productId);
    let updatedBulkOperations = [...bulkOperations];
    if (slice) {
        let lastUpdatedIndex = bulkOperations.findIndex(
            (operation) =>
                operation?.updateOne?.filter?.itemId === lastUpdatedProductId &&
                operation?.updateOne?.update?.$set?.fields?.images?.some(
                    (img) => img.imageId === lastUpdatedImageId,
                ),
        );
        if (lastUpdatedIndex === -1) {
            lastUpdatedIndex = bulkOperations.findIndex(
                (operation) =>
                    operation?.insertOne?.document?.itemId === lastUpdatedProductId &&
                    operation?.insertOne?.document?.fields?.images?.some(
                        (img) => img.imageId === lastUpdatedImageId,
                    ),
            );
        }
        updatedBulkOperations = bulkOperations.slice(
            0,
            lastUpdatedIndex === -1 ? bulkOperations.length : lastUpdatedIndex + 1,
        );
    }
    updatedBulkOperations = updatedBulkOperations.map((operation) => {
        if (
            operation?.updateOne?.filter?.itemId != null &&
            hasFailedImagesForProduct(operation.updateOne.filter.itemId)
        ) {
            return {
                updateOne: {
                    filter: operation.updateOne.filter,
                    update: {
                        $set: {
                            ...operation.updateOne.update.$set,
                            fields: {
                                ...operation.updateOne.update.$set.fields,
                                images: filterSnapshotImages(
                                    operation.updateOne.update.$set.fields.images,
                                ),
                            },
                        },
                    },
                },
            };
        }
        if (
            operation?.insertOne?.document?.itemId != null &&
            hasFailedImagesForProduct(operation.insertOne.document.itemId)
        ) {
            return {
                insertOne: {
                    document: {
                        ...operation.insertOne.document,
                        fields: {
                            ...operation.insertOne.document.fields,
                            images: filterSnapshotImages(
                                operation.insertOne.document.fields.images,
                            ),
                        },
                    },
                },
            };
        }
        return operation;
    });
    if (updatedBulkOperations.length > 0) {
        console.log(
            `[Snapshot] Writing ${updatedBulkOperations.length} image snapshot ops, lastUpdatedProductId: ${lastUpdatedProductId}, lastUpdatedImageId: ${lastUpdatedImageId}, failedImages: ${failedImages.length}, slice: ${slice}`,
        );
        await ItemSnapshot.bulkWrite(updatedBulkOperations);
    }
    return updatedBulkOperations;
};


const templateRenderer = (template, item, itemType) => {
    let tokens = {};
    if(itemType === "category") {
        tokens = {
            "[[category name]]": item.name ?? "",
        }
    } else if(itemType === "brand") {
        tokens = {
            "[[brand name]]": item.name ?? "",
            "[[name]]" : item.name ?? "",
        }
    } else {
        tokens = {
            "[[product name]]": item?.name ?? "",
            "[[sku]]": item?.sku ?? "",
            "[[price]]":
              item?.price != null ? String(item.price) : "",
            "[[currency]]": item?.currency ?? "",
            "[[type]]": item?.type ?? "",
            "[[category name]]": "",
            "[[brand]]": item?.brand_name ?? "",
            "[[mpn]]": item?.mpn ?? "",
            "[[condition]]": item?.condition ?? "",
            "[[store name]]": "",
          };
    }
    let out = template.trim() || "";
    for(const [token, value] of Object.entries(tokens)) {
        out = out.replaceAll(token, value);
    }
    return out;
}

const updateSnapshotAndReturnUpdatablePayload = async ({storeHash, itemType, items, target, jobId, template, bcChannelId = null}) => {
    try{
        // note: no need to check for slot as we are not updating any existing snapshots because we are creating only one history record for each item
        const existingSnapshots = await ItemSnapshot.find({
            storeHash,  
            itemType,
            itemId: { $in: items.map(item => (itemType === "category" ? item.category_id : item.id)) },
            target, 
        }).lean();

        const byItemId = {};
        for(const snapshot of existingSnapshots) {
            if(!byItemId[snapshot.itemId]) byItemId[snapshot.itemId] = [];
            byItemId[snapshot.itemId].push(snapshot);
        }

        const bulkOperations = [];
        const updatablePayload = [];

        for(const item of items) {
            const itemId = itemType === "category" ? item.category_id : item.id;
            const slots = byItemId[itemId] ?? [];
            const fieldData = {
                name: item.name ?? "",
                page_title: item.page_title ?? "",
                meta_description: item.meta_description ?? "",
                item_url: itemType === "category" ? item.url?.path ?? "" : item.custom_url?.url ?? "",
                images : target === "alt" ? item?.images?.length > 0 ? item?.images.map(image => {
                    return {
                        imageId: image.id,
                        altText: image.description ?? "",
                    }
                }) : [] : [],
            }



            if(slots.length === 0) {
                bulkOperations.push({ insertOne: { document: { storeHash, itemId, bcChannelId, jobHistoryId: jobId, capturedAt: new Date(), fields: fieldData, itemType, target } } });
            }
            else {
                bulkOperations.push({ updateOne: { filter: { storeHash, itemId, target, itemType }, update: { $set: { fields: fieldData, capturedAt: new Date(), jobHistoryId: jobId, bcChannelId, itemType, target } } } });
            } 
            // else {
            //     const slot2 = slots.find(slot => slot.slot === 2);
            //     bulkOperations.push({ updateOne: { filter: { storeHash, itemId, slot: 1, target, itemType }, update: { $set: { fields: slot2.fields, capturedAt: slot2.capturedAt, jobHistoryId: slot2.jobHistoryId, bcChannelId, itemType, target, is_restored: slot2.is_restored } } } });
            //     bulkOperations.push({ updateOne: { filter: { storeHash, itemId, slot: 2, target, itemType }, update: { $set: { fields: fieldData, capturedAt: new Date(), jobHistoryId: jobId, bcChannelId, itemType, target, is_restored: false } } } });
            // }

            let imagesWithAlt = [];
            if(target === "alt") {
                imagesWithAlt = item?.images.map(image => {
                    return {
                        id: image.id,
                        alt_text: templateRenderer(template, item, itemType) ?? "",
                    }
                }) ?? [];
            }

            // add images with alt text if target is alt text 
            updatablePayload.push({       
                [itemType === "category" ? "category_id" : "id"]: itemId,
                ...(target === "title" ? 
                    { page_title: templateRenderer(template, item, itemType) }
                     : target === "meta" ? { meta_description: templateRenderer(template, item, itemType) }
                     : target === "alt" ? { images: imagesWithAlt } : {}),
            }); 
        }

        // if(bulkOperations.length > 0) {
        //     await ItemSnapshot.bulkWrite(bulkOperations);
        // }

        return { updatablePayload, bulkOperations };

    } catch(error) {
        console.error("Error updating snapshot and returning payload:", error);
        throw error;
    }
}

const updateBulkCategories = async ({ storeHash, updatablePayload, done, accessToken, job, bulkOperations, type = "bulk" }) => {
    let failedIds = [];
    let lastUpdatedId = null;
    try {
        for (let i = 0; i < updatablePayload.length; i += CATEGORY_BATCH) {
            const chunk = updatablePayload.slice(i, i + CATEGORY_BATCH);
            console.log(`[Category Worker] Updating categories ${i + 1}–${i + chunk.length} of ${updatablePayload.length}`);
            let rateLimitHeaders = null;
            let response = null;
            try {
                // ✅ putWithRetry handles 429 and 5xx automatically
                response = await putWithRetry(batchUpdateCategoriesUrl(storeHash), chunk, headers(accessToken));
                done += chunk.length;
                rateLimitHeaders = response.headers;
                lastUpdatedId = chunk[chunk.length - 1].category_id;
            } catch (error) {
                const status = error?.response?.status;
                if (status === 422) {
                    console.warn(`[Category Worker] 422 on chunk ${i + 1}–${i + chunk.length}, starting binary search...`);
                    // Binary search isolates the bad category_ids
                    const chunkFailedIds = await binarySearchFailedCategories(chunk, storeHash, accessToken);
                    console.error(`[Category Worker] Failed category_ids:`, chunkFailedIds);
                    // Accumulate all failed ids across chunks
                    failedIds.push(...chunkFailedIds);

                    const validChunk = chunk.filter(cat => !chunkFailedIds.includes(cat.category_id));
                    done += validChunk.length;

                    rateLimitHeaders = response?.headers;
                    lastUpdatedId = validChunk[validChunk.length - 1].category_id;
                    // Log all failed ids from this chunk to JobHistory
                    if (chunkFailedIds.length > 0) {
                        await pushItemErrorLog({
                            job,
                            type,
                            entries: chunkFailedIds.map((id) => ({
                                itemId: id,
                                message: JSON.stringify(error?.response?.data),
                            })),
                        });
                    }
                } else if (status === 404) {
                    // Entire chunk references missing categories — log and skip
                    console.warn(`[Category Worker] 404 on chunk — logging and skipping`);
                    for (const cat of chunk) {
                        failedIds.push(cat.category_id);
                    }
                    await pushItemErrorLog({
                        job,
                        type,
                        entries: chunk.map((cat) => ({
                            itemId: cat.category_id,
                            message: "Category not found",
                        })),
                    });
                } else {
                    // Unrecoverable — abort the job
                    console.error(`[Category Worker] Unrecoverable error:`, error?.response?.data ?? error.message);
                    throw error;
                }
            }
            await job.updateProgress({
                ...job.progress,
                status: "updating",
                resource: "categories",
                processedItems: done
            });
            // Throttle based on remaining rate limit
            const remaining = rateLimitHeaders?.["x-rate-limit-requests-left"];
            if (remaining && parseInt(remaining) < RATE_LIMIT_LOW_THRESHOLD) {
                await sleep(10 * NORMAL_THROTTLE_MS);
            } else {
                await sleep(NORMAL_THROTTLE_MS);
            }
        }

        let updatedBulkOperations = [];
        if(type === "bulk"){ 
            updatedBulkOperations = await saveSnapshot({ lastUpdatedId, failedIds, bulkOperations, slice: false });
        }
        return { done, updatedBulkOperations, failedIds };
    } catch (error) {
        if(type === "bulk"){ 
            await saveSnapshot({ lastUpdatedId, failedIds, bulkOperations, slice: true });
        }
        await job.updateProgress({ ...job.progress, status: "failed", processedItems: done });
        console.error("[Category Worker] Fatal error:", error?.response?.data ?? error.message);
        throw error;
    }
}

const getErrorStatus = (error) => error?.response?.status ?? error?.status ?? null;

const isSkippableItemError = (status) => status === 422 || status === 404;

const updateBulkBrands = async ({ storeHash, updatablePayload, done, accessToken, job, bulkOperations, type = "bulk" }) => {
    let failedObjects = [];
    let lastUpdatedId = null;
    try{
        const putBrand = async (item) => {
            const { id, page_title, meta_description } = item;
            const body = {};
            if (page_title !== undefined) body.page_title = page_title;
            if (meta_description !== undefined) body.meta_description = meta_description;
            try {
                return await putWithRetry(updateBrandUrl(storeHash, id), body, headers(accessToken));
            } catch (error) {
                const status = error?.response?.status;
                // Classify the error so the caller knows how to handle it
                throw {
                    itemId: id,
                    status,
                    retryable: false, // putWithRetry already exhausted retries
                    data: error?.response?.data,
                    message: error?.response?.data?.message ?? error.message
                };
            }
        };


            for (const item of updatablePayload) {
                console.log("[Brand Worker] :Updating brand:", item.id, "job id:", job.id);
                try{
                    await putBrand(item);
                    done += 1;
                    lastUpdatedId = item.id;
                }catch(error) {
                    const status = getErrorStatus(error);
                    if (isSkippableItemError(status)) {
                      failedObjects.push({
                        itemId: error.itemId ?? item.id,
                        message: JSON.stringify(error.data ?? error?.response?.data ?? error.message),
                      });
                      continue; // optional — or just fall through
                    }
                    // Fatal — abort job (same as products)
                    console.error(`[Brand Worker] Fatal error brand id=${item.id}, status=${status}`);
                    throw error instanceof Error ? error : new Error(error.message ?? "Unrecoverable brand update error");
                }
                await job.updateProgress({
                    ...job.progress,
                  status: "updating",
                  resource: "brands",
                  processedItems : done,
                });
      
                await new Promise((resolve) => setTimeout(resolve, NORMAL_THROTTLE_MS));
              }

        if (failedObjects.length > 0) {
            await pushItemErrorLog({ job, type, entries: failedObjects });
        }

        const failedIds = failedObjects.map(object => object.itemId);
        let updatedBulkOperations = [];
        if(type === "bulk"){ 
            updatedBulkOperations = await saveSnapshot({ lastUpdatedId, failedIds, bulkOperations, slice: false });
        }

        return { done, updatedBulkOperations, failedIds };
    }catch(error) {

        if(type === "bulk"){ 
            const failedIds = failedObjects.map(object => object.itemId);
            await saveSnapshot({ lastUpdatedId, failedIds, bulkOperations, slice: true });
        }
        await job.updateProgress({ ...job.progress, status: "failed", processedItems: done });
        console.error("Error updating bulk brands:", error);
        throw error;
    }
}

const updateBulkProducts = async ({ storeHash, updatablePayload, done, accessToken, job, bulkOperations, type = "bulk" }) => {
    let failedIds = [];
    let lastUpdatedId = null;
    try{
        for (let i = 0; i < updatablePayload.length; i += PRODUCT_BATCH_LIMIT) {
            console.log("[Product Worker] :Updating products:", i, "of", updatablePayload.length, "job id:", job.id);
            const chunk = updatablePayload.slice(i, i + PRODUCT_BATCH_LIMIT);
            if (chunk.length === 0) continue;   

            console.log("[Product Worker] :Updating products chunk:", chunk);
            
            let response;
            try {
                // Attempt batch update with retry for 429/5xx
                response = await putWithRetry(batchUpdateProductsUrl(storeHash), chunk, headers(accessToken));
                done += chunk.length;
                rateLimitHeaders = response.headers;
                lastUpdatedId = chunk[chunk.length - 1].id;
            } catch (batchError) {
                const status = batchError?.response?.status;
                if (status === 422) {
                    // Isolate the failing product by retrying individually
                    console.warn("[Product Worker] Batch 422 — retrying individually");
                    for (const product of chunk) {
                        try {
                            const individualResponse = await putWithRetry(
                                batchUpdateProductsUrl(storeHash),
                                [product],
                                headers(accessToken)
                            );
                            done += 1;
                            rateLimitHeaders = individualResponse.headers;
                            lastUpdatedId = product.id;
                        } catch (individualError) {
                            const individualStatus = individualError?.response?.status;
                            console.error(`[Product Worker] Failed product id=${product.id}, status=${individualStatus}`);
                            failedIds.push(product.id);
                            await pushItemErrorLog({
                                job,
                                type,
                                entries: {
                                    itemId: product.id,
                                    message: JSON.stringify(individualError?.response?.data),
                                },
                            });
                        }
                    }
                } else if (status === 404) {
                    // Entire chunk references missing data — log all and skip
                    console.warn("[Product Worker] Batch 404 — logging chunk and skipping");
                    for (const product of chunk) {
                        failedIds.push(product.id);
                    }
                    await pushItemErrorLog({
                        job,
                        type,
                        entries: chunk.map((product) => ({
                            itemId: product.id,
                            message: "Resource not found",
                        })),
                    });
                } else {
                    // Persistent or unknown error — abort the job
                    console.error("[Product Worker] Unrecoverable batch error:", batchError?.response?.data ?? batchError.message);
                    throw new Error(batchError?.response?.data?.message ?? batchError.message);
                }
            }
    
            await job.updateProgress({ ...job.progress, status: "updating", processedItems: done });
    
            // Light throttling to avoid rate limiting
            const remaining = response?.headers["x-rate-limit-requests-left"];
            console.log("[Product Worker] :Rate limit remaining:", remaining);
            if (remaining && parseInt(remaining) < RATE_LIMIT_LOW_THRESHOLD) {
                console.log("sleeping for", 10*NORMAL_THROTTLE_MS);
              await new Promise(r => setTimeout(r, 10*NORMAL_THROTTLE_MS));
            }else{
              await new Promise(r => setTimeout(r, 3*NORMAL_THROTTLE_MS));
            }
          }
        let updatedBulkOperations = [];

        if(type === "bulk"){ 
            updatedBulkOperations = await saveSnapshot({ lastUpdatedId, failedIds, bulkOperations, slice: false });
        }
        return { done, updatedBulkOperations, failedIds };
    } catch(error) {
        if(type === "bulk"){ 
            await saveSnapshot({ lastUpdatedId, failedIds, bulkOperations, slice: true });
        }
        await job.updateProgress({ ...job.progress, status: "failed", processedItems: done });
        console.error("Error updating bulk products:", error);
        throw new Error(error.message);
    }
}


async function binarySearchFailedCategories(chunk, storeHash, accessToken) {
    const failedIds = [];
    async function search(items) {
        // Base case: single item — this is the failing category
        if (items.length === 1) {
            console.warn(`Identified failing category_id: ${items[0].category_id}`);
            failedIds.push(items[0].category_id);
            return;
        }
        const mid = Math.floor(items.length / 2);
        const left = items.slice(0, mid);
        const right = items.slice(mid);
        // Test left half
        try {
            await axios.put(batchUpdateCategoriesUrl(storeHash), left, { headers: headers(accessToken) });
            console.log(`Left half passed (${left.map(c => c.category_id)})`);
        } catch (error) {
            if (error.response?.status === 422) {
                console.warn(`Left half failed, narrowing down...`);
                await search(left);
            }
        }
        // Test right half
        try {
            await axios.put(batchUpdateCategoriesUrl(storeHash), right, { headers: headers(accessToken) });
            console.log(`Right half passed (${right.map(c => c.category_id)})`);
        } catch (error) {
            if (error.response?.status === 422) {
                console.warn(`Right half failed, narrowing down...`);
                await search(right);
            }
        }
    }
    await search(chunk);
    return failedIds;
}

const updateBulkImageAltText = async ({ storeHash, updatablePayload, done, accessToken, bulkOperations, blanksOnly, canBeUpdated, job, type = "bulk" }) => {
    let failedImages = [];
    let lastUpdatedImageId = null;
    let lastUpdatedProductId = null;
    try {
        let imageUpdates = [];

        for (const product of updatablePayload) {
            for (const image of product.images ?? []) {
                if (!image?.id) continue;
                if (blanksOnly && image.description !== "") continue;
                imageUpdates.push({
                    productId: product.id,
                    imageId: image.id,
                    alt_text: image.alt_text,
                });
            }
        }

        const totalImages = imageUpdates.length;

        if (canBeUpdated !== undefined && canBeUpdated !== null) {
            imageUpdates = imageUpdates.slice(0, canBeUpdated);
        }

        await job.updateProgress({ status: "updating", processedItems: 0, totalItems: totalImages });

        for (let i = 0; i < imageUpdates.length; i += PRODUCT_BATCH_LIMIT) {
            const chunk = imageUpdates.slice(i, i + PRODUCT_BATCH_LIMIT);
            if (chunk.length === 0) continue;

            console.log(`Updating alt text ${i + 1}–${i + chunk.length} of ${totalImages}`);

            const responses = await Promise.allSettled(
                chunk.map(({ productId, imageId, alt_text }) =>
                    putWithRetry(updateImageUrl(storeHash, productId, imageId), { description: alt_text }, headers(accessToken)),
                ),
            );

            let remaining = 0;
            for (let index = 0; index < responses.length; index++) {
                const response = responses[index];
                if (response.status === "fulfilled") {
                  done += 1;
                  remaining = response.value?.headers?.["x-rate-limit-requests-left"];
                  lastUpdatedImageId = chunk[index].imageId;
                  lastUpdatedProductId = chunk[index].productId;
                  continue;
                }
                const reason = response.reason;
                const status = getErrorStatus(reason);
                if (isSkippableItemError(status)) {
                  failedImages.push({
                    itemId: chunk[index].productId,
                    imageId: chunk[index].imageId,
                    message: JSON.stringify(reason?.response?.data ?? reason?.message),
                  });
                  continue;
                }
                // Fatal — stop entire image job
                console.error(`[Image Worker] Fatal error image productId=${chunk[index].productId}, imageId=${chunk[index].imageId}, status=${status}`);
                throw reason;
            }

            await job.updateProgress({
                status: "updating",
                processedItems: done,
                totalItems: totalImages,
            });

            if (remaining < RATE_LIMIT_LOW_THRESHOLD) {
                await sleep(3 * NORMAL_THROTTLE_MS);
            } else {
                console.log("sleeping for", NORMAL_THROTTLE_MS);
                await sleep(NORMAL_THROTTLE_MS);
            }
        }


        let updatedBulkOperations = [];

        if(type === "bulk"){ 
            updatedBulkOperations = await saveImageSnapshot({ lastUpdatedImageId, lastUpdatedProductId, failedImages, bulkOperations, slice: true });
        }   

        if (failedImages.length > 0) {
            await pushItemErrorLog({ job, type, entries: failedImages });
        }

        return { done, totalImages };
    } catch (error) {
        await job.updateProgress({ ...job.progress, status: "failed", processedItems: done });
        if(type === "bulk"){ 
            await saveImageSnapshot({ lastUpdatedImageId, lastUpdatedProductId, failedImages, bulkOperations, slice: true });
        }
        console.error("Error updating bulk image alt text:", error);
        throw error;
    }
};

module.exports = {
    MAX_RETRIES,
    MAX_PER_PAGE,
    CATEGORY_BATCH,
    BRAND_PARALLEL_THRESHOLD,
    BRAND_PARALLEL_BATCH,
    NORMAL_THROTTLE_MS,
    PRODUCT_BATCH_LIMIT,
    RATE_LIMIT_LOW_THRESHOLD,
    updateSnapshotAndReturnUpdatablePayload,
    updateBulkCategories,
    updateBulkBrands,
    updateBulkProducts,
    updateBulkImageAltText,
};