const mongoose = require("mongoose");

const channelSchema = new mongoose.Schema(
  {
    storeId: {type: mongoose.Schema.Types.ObjectId, ref: "Store", required: true},
    bcChannelId: {
      type: Number,
      required: true,
    },
    name: { type: String, default: "" },
    platform: { type: String, default: "" },
    type: { type: String, default: "" },
    status: { type: String, default: "" },
    is_visible: { type: Boolean, default: true },
    icon_url: { type: String, default: null },
    site_url: { type: String, default: null },
  },
  { timestamps: true },
);

channelSchema.index({ storeId: 1, bcChannelId: 1 }, { unique: true });

const Channel = mongoose.model("Channel", channelSchema);

module.exports = Channel;
