const mongoose = require("mongoose");

const webhookHistorySchema = new mongoose.Schema({
    storeId : {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Store",
        required: true,
    },
    resource : {
        type: String,
        enum: ["products", "categories"],
        required: true,
    },
    itemName : {
        type: String,
        default: null,
    },
    target : {
        type: String,
        enum: ["title", "meta", "alt"],
        default: null,
    },
    bcChannelId : {
        type: Number,
        default: null,
    },
    template : {
        type: String,
        default: null,
    },
    status : {
        type: String,
        enum: ["pending", "fetching", "updating", "done", "failed"],
        default: "pending",
    },
    jobId : {
        type: String,
        default: null,
    },
    resourceId : {
        type: Number,
        default: null,
    },
    totalItems : {
        type: Number,
        default: 0,
    },
    processedItems : {
        type: Number,
        default: 0,
    },
    startedAt : {
        type: Date,
        default: Date.now,
    },
    completedAt : {
        type: Date,
        default: null,
    },
    error : {
        type: String,
        default: null,
    },
}, { timestamps: true });

const WebhookHistory = mongoose.model("Webhook_history", webhookHistorySchema);

module.exports = WebhookHistory;