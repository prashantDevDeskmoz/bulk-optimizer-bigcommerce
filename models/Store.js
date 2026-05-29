const mongoose = require("mongoose");

const storeSchema = new mongoose.Schema(
    {
      store_hash: {
        type: String,
        required: true,
        unique: true,
      },
      access_token: {
        type: String,
        required: true,
      },
      scope: {
        type: String,
        required: true,
      },
      email: {
        type: String,
        default: null,
      },
      store_name: {
        type: String,
        default: null,
      },
      store_domain: {
        type: String,
        default: null,
      },
      store_url: {
        type: String,
        default: null,
      },
      platform_version: {
        type: String,
        default: null,
      },
      currency: {
        type: String,
        default: null,
      },
      timezone: {
        type: String,
        default: null,
      },
      language: {
        type: String,
        default: null,
      },
      is_active: {
        type: Boolean,
        default: true,
      },
      installed_at: {
        type: Date,
        default: Date.now,
      },
      uninstalled_at: {
        type: Date,
        default: null,
      },
      plan: {
        type: String,
        enum: ["free", "paid"],
        default: "free",
      },
      trialDaysRemaining: {
        type: Number,
        default: null, // null = never tried paid plan, 14-1 = active trial, 0 = trial used/cancelled
      },
      paypalSubscriptionId: {
        type: String,
        default: null,
      },
    },
    {
      timestamps: true,
    }
  );

storeSchema.statics.findByHash = function (hash) {
  return this.findOne({ store_hash: hash });
};

const Store = mongoose.model("Store", storeSchema);

module.exports = Store;