const Store = require("../models/Store");
const Channel = require("../models/Channel");

/**
 * Returns channels synced for this store (MongoDB), including site_url.
 */
const getChannels = async (req, res) => {
  try {
    const store = await Store.findByHash(req.storeHash);
    if (!store) {
      return res.status(404).json({ status: false, message: "Store not found" });
    }
    if (!store.is_active) {
      return res.status(403).json({ status: false, message: "Store is not active" });
    }

    const channels = await Channel
      .find({ storeId: store._id })
      .sort({ bcChannelId: 1 })
      .lean();

    return res.status(200).json({ status: true, data: channels });

  } catch (error) {
    console.error("getChannels:", error.message);
    return res.status(500).json({ status: false, message: error.message });
  }
};

module.exports = {
  getChannels,
};
