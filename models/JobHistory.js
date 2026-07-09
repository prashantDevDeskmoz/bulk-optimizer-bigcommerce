const mongoose = require("mongoose");

const jobHistorySchema = new mongoose.Schema(
  {
    jobId:          { type: String, required: true, },
    storeHash:      { type: String, required: true, },
    bcChannelId:    { type: Number, default: null },
    resource:       { type: String, enum: ["products", "categories", "brands"] },
    target:         { type: String, enum: ["title", "meta", "alt"] },
    template:       { type: String },
    status:         { type: String, enum: ["pending" , "completed", "failed"], default: "pending" },
    totalItems:     { type: Number, default: 0 },
    processedItems: { type: Number, default: 0 },
    blanksOnly:     { type: Boolean, default: false},
    startedAt:      { type: Date, default: Date.now },
    completedAt:    { type: Date, default: null },
    cruiseControl:  { type: Boolean, default: false },
    errorLog:         { type: [
      {
        itemId: { type: Number },
        imageId: { type: Number , default: null},
        message: { type: String },
      },
    ], default: [] },
    restoreStatus: { type: String, enum: ["pending", "completed", "failed"], default: null },
    errorMessage:          { type: String, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("job_history", jobHistorySchema);