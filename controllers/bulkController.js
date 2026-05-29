const Store = require("../models/Store");
const {QueueManager, QUEUE_NAMES} = require("../bullmq/queueManager");
const JobHistory = require("../models/JobHistory");
const Channel = require("../models/Channel");
const Template = require("../models/Template");
const queueManager = new QueueManager();

const updateBulk = async (req, res) => {
    try {
        const { applyTo, target, template, cruiseControl, bcChannelId, blanksOnly } = req.body;
        const store = await Store.findByHash(req.storeHash);
        const channel = await Channel.findOne({ bcChannelId });
        if (!store) {return res.status(404).json({ status: false, message: "Store not found" })}
        if (!channel && bcChannelId) {return res.status(404).json({ status: false, message: "Channel not found" })}

        await Template.findOneAndUpdate(
            { storeId: store._id, bcChannelId, applyTo, target },
            { template },    
            { returnDocument: "after", upsert: true }
        );

        const existingJob = await JobHistory.find({ 
            storeHash: req.storeHash,
            status:{$in: ["pending", "fetching", "updating"]},
        });

        if(existingJob && existingJob.length > 0) {
            return res.status(400).json({ status: false, message: "Job already exists and the template is saved" });
        }


        const accessToken = store.access_token;


        const jobData = {
            storeHash: req.storeHash,
            target,
            template,
            cruiseControl,
            accessToken,
            bcChannelId,
            blanksOnly
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

module.exports = {
    updateBulk,
    updateCruiseControl,
    saveTemplates,
    getAllTemplates,
};