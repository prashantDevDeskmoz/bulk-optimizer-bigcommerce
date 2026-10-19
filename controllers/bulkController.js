const Store = require("../models/Store");
const {QueueManager, QUEUE_NAMES} = require("../bullmq/queueManager");
const JobHistory = require("../models/JobHistory");
const RestoreHistory = require("../models/RestoreHistory");
const Channel = require("../models/Channel");
const Template = require("../models/Template");
const queueManager = new QueueManager();
const axios = require("axios");
const ItemSnapshot = require("../models/ItemSnapshot");
const { getPlanAndCheckLimit } = require("../services/planService");
const { listProductsUrl, batchUpdateProductsUrl } = require("../utils/bcApi");
const { putWithRetry, PRODUCT_BATCH_LIMIT } = require("../bullmq/workerService");

const PRODUCT_TARGET_FIELDS = { title: "page_title", meta: "meta_description" };
const MAX_MANUAL_PRODUCTS = 50;

const updateBulk = async (req, res) => {
    try {
        const { applyTo, target, template, cruiseControl, bcChannelId, blanksOnly, saveTemplate = false } = req.body;
        const store = await Store.findByHash(req.storeHash);
        const channel = await Channel.findOne({ bcChannelId });
        if (!store) {return res.status(404).json({ status: false, message: "Store not found" })}
        if (!channel && bcChannelId) {return res.status(404).json({ status: false, message: "Channel not found" })}

        // check whether the template is default or not
        const oldExistingTemplateState = await Template.findOne({ storeId: store._id, bcChannelId, applyTo, target });
        const oldExistingTemplateIsDefault = oldExistingTemplateState?.isDefault;
        const isTemplateDefault = template.trim() === "[[product name]] | [[brand]]"

        // if(saveTemplate) {
            await Template.findOneAndUpdate(
                { storeId: store._id, bcChannelId, applyTo, target },
                { template, isDefault: false },
                { returnDocument: "after", upsert: true }
            );
        // }

        const existingJob = await JobHistory.find({ 
            storeHash: req.storeHash,
            status:{$in: ["pending", "fetching", "updating"]},
        });

        if(existingJob && existingJob.length > 0) {
            return res.status(400).json({ status: false, message: "A bulk update is already in progress. Please wait for it to complete." });
        }

        const pendingRestore = await RestoreHistory.findOne({
            storeHash: req.storeHash,
            resource: applyTo,
            target,
            status: "pending",
        }).lean();
        if (pendingRestore) {
            return res.status(400).json({
                status: false,
                message: "A restore is in progress for this item type and field. Wait for it to finish before running bulk update.",
            });
        }

        const { planLimitReached, canBeUpdated } = await getPlanAndCheckLimit(store);

        if(planLimitReached || (canBeUpdated !== null && canBeUpdated <= 0)) {
            return res.status(400).json({ status: false, message: "You have reached your monthly plan limit. Upgrade your plan to continue." });
        }
        console.log("canBeUpdated:::::::::::::::::::::::::::::::::::::", canBeUpdated, "planLimitReached:::::::::::::::::::::::::::::::::::::", planLimitReached);

        const accessToken = store.access_token;


        const jobData = {
            storeHash: req.storeHash,
            target,
            template,
            cruiseControl,
            accessToken,
            bcChannelId,
            blanksOnly,
            canBeUpdated,
            storeName: oldExistingTemplateIsDefault && isTemplateDefault ? store.store_name : null,
        }

        let job = null;

        if(applyTo === "products" && target === "alt") job = await queueManager.addJob(QUEUE_NAMES.images, jobData, { jobId: `images-${Date.now()}-${req.storeHash}` });
        else if(applyTo === "products") job = await queueManager.addJob(QUEUE_NAMES.products, jobData, { jobId: `products-${Date.now()}-${req.storeHash}` });
        else if(applyTo === "categories") job = await queueManager.addJob(QUEUE_NAMES.categories, jobData, { jobId: `categories-${Date.now()}-${req.storeHash}` });
        else if(applyTo === "brands") job = await queueManager.addJob(QUEUE_NAMES.brands, jobData, { jobId: `brands-${Date.now()}-${req.storeHash}` });
        else return res.status(400).json({ status: false, message: "Invalid type" });

        console.log("job:::::::::::::::::::::::::::::::::::::", job.id);

        const jobHistory = new JobHistory({
            storeHash: req.storeHash,
            resource: applyTo,
            target,
            template,
            status: "pending",
            jobId: job.id,
            totalItems: 0,
            processedItems: 0,
            completedAt: null,
            error: null,
            bcChannelId,
            blanksOnly
        });
        await jobHistory.save();

        return res.status(200).json({status: true, message: "Bulk update job added to queue", id : job.id});

    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: false, message: error.message });
    }
}

const updateCruiseControl = async (req, res) => {
    try {
        console.log("updateCruiseControl:::::::::::::::::::::::::::::::::::::", req.body);
        const { cruiseControl, applyTo, target, bcChannelId } = req.body;
        const store = await Store.findByHash(req.storeHash);
        if (!store) {return res.status(404).json({ status: false, message: "Store not found" })}

        await Template.findOneAndUpdate(
            { storeId: store._id, bcChannelId, applyTo, target },
            { cruiseControl },
            { returnDocument: "after", upsert: true }
        );

        return res.status(200).json({ status: true, message: "Auto seo updated" });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: false, message: error.message });
    }
}

const saveTemplates = async (req, res) => {
    try {
        const {template, applyTo, target, bcChannelId, overrideDefault} = req.body;
        const store = await Store.findByHash(req.storeHash);
        if (!store) {return res.status(404).json({ status: false, message: "Store not found" })}

        // check template exists else create new one
        await Template.findOneAndUpdate({
            storeId: store._id,
            bcChannelId,
            applyTo,
            target,
        }, { 
            template,
            ...(overrideDefault ? { isDefault: false } : {}),
        }, { returnDocument: "after", upsert: true });

        return res.status(200).json({ status: true, message: "Template saved" });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: false, message: error.message });
    }
}

const getAllTemplates = async (req, res) => {
    try {
        const store = await Store.findByHash(req.storeHash);
        if (!store || !store.is_active) {return res.status(404).json({ status: false, message: "Store not found or is not active" })}

        const templates = await Template.find({ storeId: store._id });

        if(!templates) {return res.status(404).json({ status: false, message: "Templates not found" })}

        return res.status(200).json({ status: true, data: templates });
    } catch (error) {
        console.error("[getAllTemplates] error:", error.message);
        return res.status(500).json({ status: false, message: error.message });
    }
};

const getDashboardInfo = async (req, res) => {
    try {
        const store = await Store.findByHash(req.storeHash);
        if (!store || !store.is_active) {return res.status(404).json({ status: false, message: "Store not found or is not active" })}

        const accessToken = store.access_token;

        // get Total Products, Optimized Products, Queue, Quota Used

        //1. Bc api hit to get total count not products (for this we are using limit : 1)
        let products = 0;
        try{
            products = await axios.get(listProductsUrl(req.storeHash), {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "X-Auth-Token": accessToken,
                    "Content-Type": "application/json",
                },
                params: { limit: 1 },
            });
        }catch(error){
            console.error("[getDashboardInfo] error fetching products:", error.message);
        }

        const totalProducts = products?.data?.meta?.pagination?.total || 0;

        //2. Optimized Products from JobHistory where storeHash = req.storeHash and status = "completed" (sum of processedItems)
        // const optimizedItems = await JobHistory.aggregate([
        //     { $match: { storeHash: req.storeHash } },
        //     { $group: { _id: null, total: { $sum: "$processedItems" } } },
        // ]);

        // const optimizedItemsCount = optimizedItems[0]?.total || 0;

        //3. Queue from queueManager.getQueue(QUEUE_NAMES.products).count()
        const queue = await JobHistory.countDocuments({ storeHash: req.storeHash, status: {$in: ["pending"]} });

        //4. Quota Used from JobHistory where storeHash = req.storeHash and status = "completed"
        const quotaUsed = await getPlanAndCheckLimit(store);

        return res.status(200).json({ status: true, data: { totalProducts, queue, quotaUsed } });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: false, message: error.message });
    }
}

const updateProducts = async (req, res) => {
    const { bcChannelId, products } = req.body;
    if (!Array.isArray(products) || products.length === 0 || products.length > MAX_MANUAL_PRODUCTS) {
        return res.status(400).json({ status: false, message: `Send between 1 and ${MAX_MANUAL_PRODUCTS} products` });
    }

    try {
        const store = await Store.findByHash(req.storeHash);
        if (!store || !store.is_active) {return res.status(404).json({ status: false, message: "Store not found or is not active" })}

        const [runningJob, pendingRestore, { canBeUpdated, cycleStart }] = await Promise.all([
            JobHistory.exists({ storeHash: req.storeHash, status: "pending" }),
            RestoreHistory.exists({ storeHash: req.storeHash, resource: "products", status: "pending" }),
            getPlanAndCheckLimit(store),
        ]);
        if (runningJob) {
            return res.status(400).json({ status: false, message: "A bulk update is already in progress. Please wait for it to complete." });
        }
        if (pendingRestore) {
            return res.status(400).json({ status: false, message: "A restore is in progress for products. Wait for it to finish before updating." });
        }

        const headers = {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Auth-Token": store.access_token,
        };

        const { data } = await axios.get(listProductsUrl(req.storeHash), {
            headers,
            params: {
                "id:in": products.map((p) => Number(p.id)).join(","),
                limit: products.length,
                include_fields: "id,name,page_title,meta_description,custom_url",
            },
        });
        const currentById = Object.fromEntries((data?.data ?? []).map((p) => [p.id, p]));

        const changes = [];
        for (const product of products) {
            const current = currentById[Number(product.id)];
            if (!current) continue;
            const change = { id: current.id };
            for (const field of Object.values(PRODUCT_TARGET_FIELDS)) {
                if (typeof product[field] === "string" && product[field] !== (current[field] ?? "")) {
                    change[field] = product[field];
                }
            }
            if (Object.keys(change).length > 1) changes.push(change);
        }
        if (changes.length === 0) {
            return res.status(200).json({ status: true, message: "Nothing to update", data: [], failedIds: [] });
        }

        const changesByTarget = Object.fromEntries(
            Object.entries(PRODUCT_TARGET_FIELDS).map(([target, field]) => [target, changes.filter((c) => c[field] !== undefined)]),
        );
        const targets = Object.keys(changesByTarget).filter((target) => changesByTarget[target].length > 0);
        const itemCount = targets.reduce((sum, target) => sum + changesByTarget[target].length, 0);
        if (canBeUpdated !== null && itemCount > canBeUpdated) {
            return res.status(400).json({
                status: false,
                message: canBeUpdated === 0
                    ? "You have reached your monthly plan limit. Upgrade your plan to continue."
                    : `You can update ${canBeUpdated} more item(s) this month, but this update needs ${itemCount}. Upgrade your plan or update fewer products.`,
            });
        }

        const failed = {};
        for (let i = 0; i < changes.length; i += PRODUCT_BATCH_LIMIT) {
            const chunk = changes.slice(i, i + PRODUCT_BATCH_LIMIT);
            try {
                await putWithRetry(batchUpdateProductsUrl(req.storeHash), chunk, headers);
            } catch (batchError) {
                if (batchError?.response?.status !== 422) {
                    const message = JSON.stringify(batchError?.response?.data ?? batchError.message);
                    for (const change of chunk) failed[change.id] = message;
                    continue;
                }
                for (const change of chunk) {
                    try {
                        await putWithRetry(batchUpdateProductsUrl(req.storeHash), [change], headers);
                    } catch (itemError) {
                        failed[change.id] = JSON.stringify(itemError?.response?.data ?? itemError.message);
                    }
                }
            }
        }

        const capturedAt = new Date();
        const jobHistoryId = `manual-${capturedAt.getTime()}-${req.storeHash}`;
        const snapshotOperations = [];
        for (const target of targets) {
            const field = PRODUCT_TARGET_FIELDS[target];
            for (const change of changesByTarget[target]) {
                if (failed[change.id]) continue;
                const current = currentById[change.id];
                snapshotOperations.push({
                    updateOne: {
                        filter: { storeHash: req.storeHash, itemType: "product", target, itemId: change.id },
                        update: {
                            $set: {
                                jobHistoryId,
                                bcChannelId: Number(bcChannelId) || null,
                                capturedAt,
                                is_restored: false,
                                fields: {
                                    name: current.name ?? "",
                                    page_title: current.page_title ?? "",
                                    meta_description: current.meta_description ?? "",
                                    item_url: current.custom_url?.url ?? "",
                                    images: [],
                                },
                                updated: { [field]: change[field] },
                            },
                            $unset: { restoredAt: "" },
                        },
                        upsert: true,
                    },
                });
            }
        }
        if (snapshotOperations.length > 0) {
            await Promise.all([
                ItemSnapshot.bulkWrite(snapshotOperations),
                Store.updateOne({ _id: store._id }, [{
                    $set: {
                        manualUsage: {
                            cycleStart,
                            count: {
                                $cond: [
                                    { $eq: ["$manualUsage.cycleStart", cycleStart] },
                                    { $add: [{ $ifNull: ["$manualUsage.count", 0] }, snapshotOperations.length] },
                                    snapshotOperations.length,
                                ],
                            },
                        },
                    },
                }], { updatePipeline: true }),
            ]);
        }

        const updated = changes.filter((c) => !failed[c.id]);
        const failedIds = Object.keys(failed).map(Number);
        return res.status(200).json({
            status: updated.length > 0,
            message: failedIds.length === 0
                ? `${updated.length} product(s) updated`
                : `${updated.length} product(s) updated, ${failedIds.length} failed`,
            data: updated,
            failedIds,
        });
    } catch (error) {
        console.error("[updateProducts] error:", error?.response?.data ?? error.message);
        return res.status(500).json({ status: false, message: error?.response?.data?.title ?? error.message });
    }
};

module.exports = {
    updateBulk,
    updateProducts,
    updateCruiseControl,
    saveTemplates,
    getAllTemplates,
    getDashboardInfo
}