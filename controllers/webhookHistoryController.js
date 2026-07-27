const Store = require("../models/Store");
const WebhookHistory = require("../models/WebhookHistory");
const axios = require("axios");
const {
  batchUpdateProductsUrl,
  batchUpdateCategoriesUrl,
  updateImageUrl,
} = require("../utils/bcApi");

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

/**
 * POST /webhook-histories/restore
 * Body: { id } — child WebhookHistory _id with previous values
 * Sync restore (single item); deletes history on success.
 */
const restoreWebhookHistory = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ status: false, message: "id is required" });
    }

    const store = await Store.findByHash(req.storeHash);
    if (!store || !store.is_active) {
      return res.status(404).json({ status: false, message: "Store not found or is not active" });
    }

    const history = await WebhookHistory.findOne({ _id: id, storeId: store._id });
    if (!history) {
      return res.status(404).json({ status: false, message: "Webhook history not found" });
    }
    if (!history.target || history.resourceId == null) {
      return res.status(400).json({ status: false, message: "History is not restorable" });
    }
    if (!history.previous) {
      return res.status(400).json({ status: false, message: "No previous values to restore" });
    }

    const headers = {
      "X-Auth-Token": store.access_token,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const itemId = history.resourceId;
    const previous = history.previous;

    if (history.resource === "products" && history.target === "alt") {
      const images = previous.images ?? [];
      for (let i = 0; i < images.length; i += 10) {
        const chunk = images.slice(i, i + 10);
        const results = await Promise.allSettled(
          chunk.map((image) =>
            axios.put(
              updateImageUrl(req.storeHash, itemId, image.imageId),
              { description: image.altText ?? "" },
              { headers },
            ),
          ),
        );
        const failed = results.find((r) => r.status === "rejected");
        if (failed) {
          throw new Error(
            failed.reason?.response?.data?.message ??
              failed.reason?.message ??
              "Failed to restore image alt",
          );
        }
      }
    } else if (history.resource === "products") {
      await axios.put(
        batchUpdateProductsUrl(req.storeHash),
        [
          {
            id: itemId,
            ...(history.target === "title" && { page_title: previous.page_title ?? "" }),
            ...(history.target === "meta" && { meta_description: previous.meta_description ?? "" }),
          },
        ],
        { headers },
      );
    } else if (history.resource === "categories") {
      await axios.put(
        batchUpdateCategoriesUrl(req.storeHash),
        [
          {
            category_id: itemId,
            ...(history.target === "title" && { page_title: previous.page_title ?? "" }),
            ...(history.target === "meta" && { meta_description: previous.meta_description ?? "" }),
          },
        ],
        { headers },
      );
    } else {
      return res.status(400).json({ status: false, message: "Invalid resource or target" });
    }

    await history.deleteOne();

    return res.status(200).json({ status: true, message: "Restored successfully" });
  } catch (error) {
    console.error("restoreWebhookHistory:", error?.response?.data ?? error.message);
    return res.status(500).json({
      status: false,
      message: error?.response?.data?.message ?? error.message,
    });
  }
};

module.exports = {
  getWebhookHistories,
  restoreWebhookHistory,
};
