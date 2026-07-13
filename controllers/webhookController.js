const Store = require("../models/Store");
const WebhookHistory = require("../models/WebhookHistory");
const { QueueManager, QUEUE_NAMES } = require("../bullmq/queueManager");

const queueManager = new QueueManager();

/**
 * POST /webhooks/bigcommerce/product
 * BigCommerce notifies here when a product is created (store/product/created).
 * Enqueues cruise-control work; processing runs in the webhook worker.
 */
const handleProductCreatedWebhook = async (req, res) => {
  console.log("handleProductCreatedWebhook:", req.body);
  let parentWebhookHistory = null;
  try {
    const payload = req.body;
    const storeHash = payload.producer.split("/")[1];
    const productId = payload.data.id;

    const store = await Store.findByHash(storeHash);
    if (!store || !store.is_active) {
      return res.status(404).json({ status: false, message: "Store not found or not active" });
    }
    if (store.plan === "free") {
      return res.status(200).json({ status: true, message: "Free plan does not support webhooks" });
    }

    parentWebhookHistory = await new WebhookHistory({
      storeId: store._id,
      resource: "products",
      resourceId: productId,
      status: "pending",
      startedAt: new Date(),
    }).save();

    const job = await queueManager.addJob(
      QUEUE_NAMES.webhooks,
      {
        storeHash,
        resource: "products",
        resourceId: productId,
        webhookHistoryId: parentWebhookHistory._id.toString(),
      },
      { jobId: `webhook-product-${storeHash}-${productId}-${Date.now()}` },
    );

    await WebhookHistory.findByIdAndUpdate(parentWebhookHistory._id, { jobId: job.id });

    return res.status(200).json({
      status: true,
      message: "Product created webhook queued",
      jobId: job.id,
    });
  } catch (err) {
    console.error("handleProductCreatedWebhook:", err.message);
    if (parentWebhookHistory?._id) {
      await WebhookHistory.findByIdAndUpdate(parentWebhookHistory._id, {
        status: "failed",
        error: err.message,
        completedAt: new Date(),
      });
    }
    return res.status(500).json({ status: false, message: err.message });
  }
};

/**
 * POST /webhooks/bigcommerce/category
 * Enqueues cruise-control work; processing runs in the webhook worker.
 */
const handleCategoryCreatedWebhook = async (req, res) => {
  console.log("handleCategoryCreatedWebhook:", req.body);
  let parentWebhookHistory = null;
  try {
    const payload = req.body;
    const storeHash = payload.producer.split("/")[1];
    const categoryId = payload.data.id;

    const store = await Store.findByHash(storeHash);
    if (!store || !store.is_active) {
      return res.status(404).json({ status: false, message: "Store not found or not active" });
    }
    if (store.plan === "free") {
      return res.status(200).json({ status: true, message: "Free plan does not support webhooks" });
    }

    parentWebhookHistory = await new WebhookHistory({
      storeId: store._id,
      resource: "categories",
      resourceId: categoryId,
      status: "pending",
      startedAt: new Date(),
    }).save();

    const job = await queueManager.addJob(
      QUEUE_NAMES.webhooks,
      {
        storeHash,
        resource: "categories",
        resourceId: categoryId,
        webhookHistoryId: parentWebhookHistory._id.toString(),
      },
      { jobId: `webhook-category-${storeHash}-${categoryId}-${Date.now()}` },
    );

    await WebhookHistory.findByIdAndUpdate(parentWebhookHistory._id, { jobId: job.id });

    return res.status(200).json({
      status: true,
      message: "Category created webhook queued",
      jobId: job.id,
    });
  } catch (e) {
    console.error("handleCategoryCreatedWebhook:", e.message);
    if (parentWebhookHistory?._id) {
      await WebhookHistory.findByIdAndUpdate(parentWebhookHistory._id, {
        status: "failed",
        error: e.message,
        completedAt: new Date(),
      });
    }
    return res.status(500).json({ status: false, message: e.message });
  }
};

module.exports = {
  handleProductCreatedWebhook,
  handleCategoryCreatedWebhook,
};
