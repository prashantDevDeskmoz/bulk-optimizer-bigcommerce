const Store = require("../models/Store");
const {QueueManager, QUEUE_NAMES} = require("../bullmq/queueManager");
const JobHistory = require("../models/JobHistory");
const Channel = require("../models/Channel");
const Template = require("../models/Template");
const queueManager = new QueueManager();
const axios = require("axios");
const { getPlanAndCheckLimit } = require("../services/planService");
const { listProductsUrl } = require("../utils/bcApi");

const updateBulk = async (req, res) => {
    try {
        const { applyTo, target, template, cruiseControl, bcChannelId, blanksOnly, saveTemplate = false } = req.body;
        const store = await Store.findByHash(req.storeHash);
        const channel = await Channel.findOne({ bcChannelId });
        if (!store) {return res.status(404).json({ status: false, message: "Store not found" })}
        if (!channel && bcChannelId) {return res.status(404).json({ status: false, message: "Channel not found" })}

        if(saveTemplate) {
            await Template.findOneAndUpdate(
                { storeId: store._id, bcChannelId, applyTo, target },
                { template },    
                { returnDocument: "after", upsert: true }
            );
        }

        const existingJob = await JobHistory.find({ 
            storeHash: req.storeHash,
            status:{$in: ["pending", "fetching", "updating"]},
        });

        if(existingJob && existingJob.length > 0) {
            return res.status(400).json({ status: false, message: "Job already exists and the template is saved" });
        }

        const { planLimitReached, canBeUpdated } = await getPlanAndCheckLimit(store);

        if(planLimitReached || canBeUpdated <= 0) {
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
            canBeUpdated
        }

        let job = null;

        if(applyTo === "products") job = await queueManager.addJob(QUEUE_NAMES.products, jobData, { jobId: `products-${Date.now()}-${req.storeHash}` });
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

        return res.status(200).json({ status: true, message: "Cruise control updated" });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: false, message: error.message });
    }
}

const saveTemplates = async (req, res) => {
    try {
        const {template, applyTo, target, bcChannelId} = req.body;
        const store = await Store.findByHash(req.storeHash);
        if (!store) {return res.status(404).json({ status: false, message: "Store not found" })}

        await Template.findOneAndUpdate({
            storeId: store._id,
            bcChannelId,
            applyTo,
            target,
        }, { template }, { returnDocument: "after", upsert: true });

        return res.status(200).json({ status: true, message: "Template saved" });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: false, message: error.message });
    }
}

const getAllTemplates = async (req, res) => {
    console.log("getAllTemplates:::::::::::::::::::::::::::::::::::::", req.storeHash);
    try {
        const store = await Store.findByHash(req.storeHash);
        if (!store) {return res.status(404).json({ status: false, message: "Store not found" })}

        const templates = await Template.find({ storeId: store._id });

        if(!templates) {return res.status(404).json({ status: false, message: "Templates not found" })}

        return res.status(200).json({ status: true, data: templates });
    } catch (error) {
        console.error("[getAllTemplates] error:", error.message);
        return res.status(500).json({ status: false, message: error.message });
    }
};

const getJobStatus = async (req, res) => {
    try {
        const { jobId } = req.body;
        const enriched = await Promise.all(
      histories.map(async (history) => {
        if (history.status !== "pending") return history;

        try {
          const job = await queueManager.getJob(QUEUE_NAMES.products, history.jobId);
          if (!job) return history;

          return {
            ...history,
            redis: {
              jobState: await job.getState(),         // waiting, active, delayed, etc.
              progress: job.progress,                  // 0-100 if you track progress
              processedOn: job.processedOn ?? null,
              finishedOn: job.finishedOn ?? null,
              failedReason: job.failedReason ?? null,
              attemptsMade: job.attemptsMade ?? 0,
            },
          };
        } catch (err) {
          console.warn(`Redis fetch failed for jobId ${history.jobId}:`, err.message);
          return history; // fallback to DB data if Redis fails
        }
      })
    );
        console.log("job:::::::::::::::::::::::::::::::::::::", job);
        return res.status(200).json({ status: true, data: job.progress });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: false, message: error.message });
    }
}

const getDashboardInfo = async (req, res) => {
    try {
        const store = await Store.findByHash(req.storeHash);
        if (!store) {return res.status(404).json({ status: false, message: "Store not found" })}

        const accessToken = store.access_token;

        // get Total Products, Optimized Products, Queue, Quota Used
        //1. Total Products from bc api limit 1 , meta.pagination.total_items

        const products = await axios.get(listProductsUrl(req.storeHash), {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "X-Auth-Token": accessToken,
                "Content-Type": "application/json",
            },
            params: {
                limit: 1,
            },
        });

        console.log("products:::::::::::::::::::::::::::::::::::::", products.data);

        const totalProducts = products.data.meta.pagination.total;

        //2. Optimized Products from JobHistory where storeHash = req.storeHash and status = "completed"
        const optimizedItems = await JobHistory.aggregate([
            { $match: { storeHash: req.storeHash } },
            { $group: { _id: null, total: { $sum: "$processedItems" } } },
        ]);

        const optimizedItemsCount = optimizedItems[0]?.total || 0;

        //3. Queue from queueManager.getQueue(QUEUE_NAMES.products).count()
        const queue = await JobHistory.countDocuments({ storeHash: req.storeHash, status: {$in: ["pending"]} });

        //4. Quota Used from JobHistory where storeHash = req.storeHash and status = "completed"
        const quotaUsed = await getPlanAndCheckLimit(store);

        return res.status(200).json({ status: true, data: { totalProducts, optimizedItemsCount, queue, quotaUsed } });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: false, message: error.message });
    }
}

module.exports = {
    updateBulk,
    updateCruiseControl,
    saveTemplates,
    getAllTemplates,
    getJobStatus,
    getDashboardInfo
}