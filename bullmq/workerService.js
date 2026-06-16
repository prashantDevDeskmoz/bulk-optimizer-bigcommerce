const ItemSnapshot = require("../models/ItemSnapshot");
const axios = require("axios");
const { batchUpdateCategoriesUrl, batchUpdateProductsUrl, updateBrandUrl } = require("../utils/bcApi");

const headers = (accessToken) => {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Auth-Token": accessToken,
    };
  }

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
    let out = template || "";
    for(const [token, value] of Object.entries(tokens)) {
        out = out.replaceAll(token, value);
    }
    return out;
}

const updateSnapshotAndReturnUpdatablePayload = async ({storeHash, itemType, items, target, jobId, template, bcChannelId = null}) => {
    try{
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
                bulkOperations.push({ insertOne: { document: { storeHash, itemId, bcChannelId, jobHistoryId: jobId, slot: 1, capturedAt: new Date(), fields: fieldData, itemType, target } } });
            } else if(slots.length === 1) {
                bulkOperations.push({ insertOne: { document: { storeHash, itemId, bcChannelId, jobHistoryId: jobId, slot: 2, capturedAt: new Date(), fields: fieldData, itemType, target } } });
            } else {
                const slot2 = slots.find(slot => slot.slot === 2);
                bulkOperations.push({ updateOne: { filter: { storeHash, itemId, slot: 1, target, itemType }, update: { $set: { fields: slot2.fields, capturedAt: slot2.capturedAt, jobHistoryId: slot2.jobHistoryId, bcChannelId, itemType, target, is_restored: slot2.is_restored } } } });
                bulkOperations.push({ updateOne: { filter: { storeHash, itemId, slot: 2, target, itemType }, update: { $set: { fields: fieldData, capturedAt: new Date(), jobHistoryId: jobId, bcChannelId, itemType, target, is_restored: false } } } });
            }

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

        if(bulkOperations.length > 0) {
            await ItemSnapshot.bulkWrite(bulkOperations);
        }

        return updatablePayload;

    } catch(error) {
        console.error("Error updating snapshot and returning payload:", error);
        throw error;
    }
}

const updateBulkCategories = async ({storeHash, updatablePayload, done, NORMAL_THROTTLE_MS, CATEGORY_BATCH, accessToken, job}) => {
    try{
        for (let i = 0; i < updatablePayload.length; i += CATEGORY_BATCH) {
            const chunk = updatablePayload.slice(i, i + CATEGORY_BATCH);
    
            console.log(`Updating categories ${i + 1}–${i + chunk.length} of ${updatablePayload.length}`);
    
            await axios.put(batchUpdateCategoriesUrl(storeHash), chunk, { headers: headers(accessToken) });
    
            done += chunk.length;
            await job.updateProgress({ ...job.progress, status: "updating", resource: "categories", processedItems : done });
    
            // Light throttling to avoid rate limiting
            await new Promise((resolve) => setTimeout(resolve, NORMAL_THROTTLE_MS));
          }
          return { done };
    } catch(error) {
        console.error("Error updating bulk categories:", error);
        throw error;
    }
}

const updateBulkBrands = async ({storeHash, updatablePayload, done, NORMAL_THROTTLE_MS, BRAND_PARALLEL_THRESHOLD, BRAND_PARALLEL_BATCH, accessToken, job}) => {
    try{
        const putBrand = (item) => {
            const { id, page_title, meta_description } = item;
            const body = {};
            if (page_title !== undefined) body.page_title = page_title;
            if (meta_description !== undefined) body.meta_description = meta_description;
            return axios.put(updateBrandUrl(storeHash, id), body, {
              headers: headers(accessToken),
            });
          };


        if (updatablePayload.length >= BRAND_PARALLEL_THRESHOLD) {
            for (let i = 0; i < updatablePayload.length; i += BRAND_PARALLEL_BATCH) {
              const chunk = updatablePayload.slice(i, i + BRAND_PARALLEL_BATCH);
              console.log(
                `[Brand Worker] Updating brands ${i + 1}–${i + chunk.length} of ${updatablePayload.length} (batch of ${BRAND_PARALLEL_BATCH})`,
              );
    
              await Promise.all(chunk.map((item) => putBrand(item)));
    
              done += chunk.length;
              await job.updateProgress({
                  ...job.progress,
                status: "updating",
                resource: "brands",
                processedItems : done,
              });
    
              //2x throttle for parallel updates in batches to avoid rate limiting
              await new Promise((resolve) => setTimeout(resolve, 2*NORMAL_THROTTLE_MS));
            }
          } else {
            for (const item of updatablePayload) {
              console.log("[Brand Worker] :Updating brand:", item.id, "job id:", job.id);
              await putBrand(item);
              done += 1;
              await job.updateProgress({
                  ...job.progress,
                status: "updating",
                resource: "brands",
                processedItems : done,
              });
    
              await new Promise((resolve) => setTimeout(resolve, NORMAL_THROTTLE_MS));
            }
          }
          return { done };
    }catch(error) {
        console.error("Error updating bulk brands:", error);
        throw error;
    }
}

const updateBulkProducts = async ({storeHash, updatablePayload, done, NORMAL_THROTTLE_MS, PRODUCT_BATCH_LIMIT, accessToken, job}) => {
    try{
        for (let i = 0; i < updatablePayload.length; i += PRODUCT_BATCH_LIMIT) {
            console.log("[Product Worker] :Updating products:", i, "of", updatablePayload.length, "job id:", job.id);
            const chunk = updatablePayload.slice(i, i + PRODUCT_BATCH_LIMIT);
            if (chunk.length === 0) continue;   

            console.log("[Product Worker] :Updating products chunk:", chunk);
    
            const response = await axios.put(batchUpdateProductsUrl(storeHash), chunk, { headers: headers(accessToken) });
            done += chunk.length;
    
            await job.updateProgress({ ...job.progress, status: "updating", processedItems: done });
    
            // Light throttling to avoid rate limiting
            const remaining = response.headers["x-rate-limit-requests-left"];
            console.log("[Product Worker] :Rate limit remaining:", remaining);
            if (remaining && parseInt(remaining) < 50) {
              await new Promise(r => setTimeout(r, 10*NORMAL_THROTTLE_MS));
            }else{
              await new Promise(r => setTimeout(r, 3*NORMAL_THROTTLE_MS));
            }
          }
          return { done };
    } catch(error) {
        console.error("Error updating bulk products:", error.message);
        throw new Error(error.message);
    }
}

module.exports = {
    updateSnapshotAndReturnUpdatablePayload,
    updateBulkCategories,
    updateBulkBrands,
    updateBulkProducts,
}