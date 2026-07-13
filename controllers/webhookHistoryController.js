const Store = require("../models/Store");
const WebhookHistory = require("../models/WebhookHistory");

/**
 * GET /webhook-histories
 * Authorization: Bearer <app session JWT>
 *
 * Query (optional):
 *   bcChannelId — filter by channel
 *   resource    — products | categories
 *   target      — title | meta | alt
 *   status      — pending | fetching | updating | done | failed
 *   limit       — max rows (default 50, max 100)
 *   page        — page number (default 1)
 */
const getWebhookHistories = async (req, res) => {
  try {
    const store = await Store.findByHash(req.storeHash);
    if (!store || !store.is_active) {
      return res.status(404).json({
        status: false,
        message: "Store not found or is not active",
      });
    }

    const filter = { storeId: store._id, target : { $ne: null } };

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const [histories, total] = await Promise.all([
      WebhookHistory.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      WebhookHistory.countDocuments(filter),
    ]);

    return res.status(200).json({
      status: true,
      data: histories,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 0,
      },
    });
  } catch (error) {
    console.error("getWebhookHistories:", error.message);
    return res.status(500).json({
      status: false,
      message: error.message,
    });
  }
};

module.exports = {
  getWebhookHistories,
};
