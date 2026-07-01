const mongoose = require("mongoose");

const restoreHistorySchema = new mongoose.Schema(
  {
    restoreJobId:   { type: String, required: true, unique: true },
    sourceJobId:    { type: String, required: true },
    storeHash:      { type: String, required: true },
    bcChannelId:    { type: Number, default: null },
    resource:       { type: String, enum: ["products", "categories", "brands"] },
    target:         { type: String, enum: ["title", "meta", "alt"] },
    status:         { type: String, enum: ["pending", "completed", "failed"], default: "pending" },
    totalItems:     { type: Number, default: 0 },
    processedItems: { type: Number, default: 0 },
    startedAt:      { type: Date, default: Date.now },
    completedAt:    { type: Date, default: null },
    errorLog: {
      type: [
        {
          itemId:  { type: Number },
          imageId: { type: Number, default: null },
          message: { type: String },
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
);

restoreHistorySchema.index({ storeHash: 1, createdAt: -1 });
restoreHistorySchema.index({ sourceJobId: 1, status: 1 });

module.exports = mongoose.model("restore_history", restoreHistorySchema);
