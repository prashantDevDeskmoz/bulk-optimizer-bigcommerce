const { Worker } = require("bullmq");
const axios = require("axios");
const redis = require("../../redis");
const Store = require("../../models/Store");
const Template = require("../../models/Template");
const WebhookHistory = require("../../models/WebhookHistory");
const {
  putWithRetry,
  NORMAL_THROTTLE_MS,
  RATE_LIMIT_LOW_THRESHOLD,
} = require("../workerService");
const {
  batchUpdateCategoriesUrl,
  batchUpdateProductsUrl,
  getProductUrl,
  listTreeCategoriesUrl,
  listTreesUrl,
  productChannelAssignmentsUrl,
} = require("../../utils/bcApi");
const { QUEUE_NAMES } = require("../queueManager");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const headers = (accessToken) => ({
  Accept: "application/json",
  "Content-Type": "application/json",
  "X-Auth-Token": accessToken,
});

function renderProductTemplate(template, product) {
  const dict = {
    "[[product name]]": product?.name ?? "",
    "[[sku]]": product?.sku ?? "",
    "[[price]]": product?.price != null ? String(product.price) : "",
    "[[currency]]": product?.currency ?? "",
    "[[type]]": product?.type ?? "",
    "[[category name]]": "",
    "[[brand]]": product?.brand_name ?? "",
    "[[mpn]]": product?.mpn ?? "",
    "[[condition]]": product?.condition ?? "",
    "[[store name]]": "",
  };
  let out = template.trim() ?? "";
  for (const [token, value] of Object.entries(dict)) {
    out = out.replaceAll(token, value);
  }
  return out;
}

function renderCategoryTemplate(template, category) {
  const dict = {
    "[[category name]]": category?.name ?? "",
  };
  let out = template.trim() ?? "";
  for (const [token, value] of Object.entries(dict)) {
    out = out.replaceAll(token, value);
  }
  return out;
}

async function getChannelIdsForProduct(storeHash, productId, accessToken) {
  const { data } = await axios.get(productChannelAssignmentsUrl(storeHash), {
    headers: headers(accessToken),
    params: { "product_id:in": productId },
  });
  const assignments = Array.isArray(data?.data) ? data.data : [];
  return [
    ...new Set(
      assignments
        .map((row) => row?.channel_id)
        .filter((id) => id != null && id !== ""),
    ),
  ];
}

async function throttleFromResponse(response) {
  const remaining = response?.headers?.["x-rate-limit-requests-left"];
  if (remaining && parseInt(remaining, 10) < RATE_LIMIT_LOW_THRESHOLD) {
    await sleep(10 * NORMAL_THROTTLE_MS);
  } else {
    await sleep(NORMAL_THROTTLE_MS);
  }
}

async function applyProductUpdate({
  target,
  template,
  storeHash,
  productId,
  productData,
  accessToken,
  storeId,
  bcChannelId,
}) {
  const child = await new WebhookHistory({
    storeId,
    resource: "products",
    target,
    template,
    bcChannelId,
    status: "updating",
    startedAt: new Date(),
  }).save();

  try {
    const rendered = renderProductTemplate(template, productData);
    const updatePayload =
      target === "title"
        ? { id: productId, page_title: rendered }
        : { id: productId, meta_description: rendered };

    const response = await putWithRetry(
      batchUpdateProductsUrl(storeHash),
      [updatePayload],
      headers(accessToken),
    );
    await throttleFromResponse(response);

    await WebhookHistory.findByIdAndUpdate(child._id, {
      status: "done",
      itemName: productData?.name ?? "",
      completedAt: new Date(),
    });
    return true;
  } catch (e) {
    await WebhookHistory.findByIdAndUpdate(child._id, {
      status: "failed",
      error: e.message,
      itemName: productData?.name ?? "",
      completedAt: new Date(),
    });
    throw e;
  }
}

async function applyCategoryUpdate({
  target,
  template,
  storeHash,
  categoryId,
  categoryData,
  accessToken,
  storeId,
  bcChannelId,
}) {
  const child = await new WebhookHistory({
    storeId,
    resource: "categories",
    target,
    template,
    bcChannelId,
    status: "updating",
    startedAt: new Date(),
  }).save();

  try {
    const updates = [
      {
        category_id: categoryId,
        ...(target === "title"
          ? { page_title: renderCategoryTemplate(template, categoryData) }
          : { meta_description: renderCategoryTemplate(template, categoryData) }),
      },
    ];

    const response = await putWithRetry(
      batchUpdateCategoriesUrl(storeHash),
      updates,
      headers(accessToken),
    );
    await throttleFromResponse(response);

    await WebhookHistory.findByIdAndUpdate(child._id, {
      status: "done",
      itemName: categoryData?.name ?? "",
      completedAt: new Date(),
    });
    return true;
  } catch (e) {
    await WebhookHistory.findByIdAndUpdate(child._id, {
      status: "failed",
      error: e.message,
      itemName: categoryData?.name ?? "",
      completedAt: new Date(),
    });
    throw e;
  }
}

async function processProductWebhook(job, store, webhookHistoryId) {
  const { resourceId: productId } = job.data;
  const accessToken = store.access_token;

  await WebhookHistory.findByIdAndUpdate(webhookHistoryId, {
    status: "fetching",
    resourceId: productId,
  });
  await job.updateProgress({ status: "fetching", processedItems: 0, totalItems: 0 });

  const { data: productRes } = await axios.get(getProductUrl(store.store_hash, productId), {
    headers: headers(accessToken),
  });
  const productData = productRes?.data;
  if (!productData?.id) {
    throw new Error("Product not found in catalog");
  }

  const channelIds = await getChannelIdsForProduct(store.store_hash, productId, accessToken);
  if (channelIds.length === 0) {
    await WebhookHistory.findByIdAndUpdate(webhookHistoryId, {
      status: "done",
      itemName: productData?.name ?? "",
      completedAt: new Date(),
      totalItems: 0,
      processedItems: 0,
    });
    await job.updateProgress({ status: "done", processedItems: 0, totalItems: 0 });
    return;
  }

  const cruiseTemplates = await Template.find({
    storeId: store._id,
    bcChannelId: { $in: channelIds.map(String) },
    applyTo: "products",
    target: { $in: ["title", "meta"] },
    cruiseControl: true,
    template: { $ne: null, $ne: "" },
  });

  let cruiseItems = [];
  for (const channelId of channelIds) {
    const forChannel = cruiseTemplates.filter(
      (item) => String(item.bcChannelId) === String(channelId),
    );
    const titleTemplate = forChannel.find((item) => item.target === "title");
    const metaTemplate = forChannel.find((item) => item.target === "meta");

    if (titleTemplate && !cruiseItems.some((t) => t.target === "title")) cruiseItems.push(titleTemplate);
    if (metaTemplate && !cruiseItems.some((t) => t.target === "meta")) cruiseItems.push(metaTemplate);
  }

  cruiseItems = cruiseItems.filter((item) => item.template);
  const total = cruiseItems.length;

  await WebhookHistory.findByIdAndUpdate(webhookHistoryId, {
    status: total === 0 ? "done" : "updating",
    itemName: productData?.name ?? "",
    totalItems: total,
    processedItems: 0,
    ...(total === 0 ? { completedAt: new Date() } : {}),
  });
  await job.updateProgress({ status: total === 0 ? "done" : "updating", processedItems: 0, totalItems: total });

  if (total === 0) return;

  let done = 0;
  for (const item of cruiseItems) {
    await applyProductUpdate({
      target: item.target,
      template: item.template,
      storeHash: store.store_hash,
      productId,
      productData,
      accessToken,
      storeId: store._id,
      bcChannelId: item.bcChannelId,
    });
    done += 1;
    await job.updateProgress({ status: "updating", processedItems: done, totalItems: total });
    await WebhookHistory.findByIdAndUpdate(webhookHistoryId, {
      status: "updating",
      processedItems: done,
      totalItems: total,
    });
  }

  await WebhookHistory.findByIdAndUpdate(webhookHistoryId, {
    status: "done",
    processedItems: done,
    totalItems: total,
    completedAt: new Date(),
  });
  await job.updateProgress({ status: "done", processedItems: done, totalItems: total });
}

async function processCategoryWebhook(job, store, webhookHistoryId) {
  const { resourceId: categoryId } = job.data;
  const accessToken = store.access_token;

  await WebhookHistory.findByIdAndUpdate(webhookHistoryId, {
    status: "fetching",
    resourceId: categoryId,
  });
  await job.updateProgress({ status: "fetching", processedItems: 0, totalItems: 0 });

  const category = await axios.get(listTreeCategoriesUrl(store.store_hash), {
    headers: headers(accessToken),
    params: { "category_id:in": categoryId },
  });
  const categoryData = category.data.data[0];
  if (!categoryData) {
    throw new Error("Category not found in catalog");
  }

  const tree = await axios.get(listTreesUrl(store.store_hash), {
    headers: headers(accessToken),
    params: { "id:in": categoryData.tree_id },
  });
  const channelId = tree.data.data[0]?.channels?.[0];
  if (channelId == null) {
    await WebhookHistory.findByIdAndUpdate(webhookHistoryId, {
      status: "done",
      itemName: categoryData?.name ?? "",
      completedAt: new Date(),
      totalItems: 0,
      processedItems: 0,
    });
    await job.updateProgress({ status: "done", processedItems: 0, totalItems: 0 });
    return;
  }

  const allCruiseControlStatusesForChannel = await Template.find({
    storeId: store._id,
    bcChannelId: channelId,
    applyTo: "categories",
  });

  const cruiseItems = allCruiseControlStatusesForChannel.filter(
    (item) =>
      item.cruiseControl &&
      (item.target === "title" || item.target === "meta") &&
      item.template,
  );
  const total = cruiseItems.length;

  await WebhookHistory.findByIdAndUpdate(webhookHistoryId, {
    status: total === 0 ? "done" : "updating",
    itemName: categoryData?.name ?? "",
    bcChannelId: channelId,
    totalItems: total,
    processedItems: 0,
    ...(total === 0 ? { completedAt: new Date() } : {}),
  });
  await job.updateProgress({ status: total === 0 ? "done" : "updating", processedItems: 0, totalItems: total });

  if (total === 0) return;

  let done = 0;
  for (const item of cruiseItems) {
    await applyCategoryUpdate({
      target: item.target,
      template: item.template,
      storeHash: store.store_hash,
      categoryId,
      categoryData,
      accessToken,
      storeId: store._id,
      bcChannelId: channelId,
    });
    done += 1;
    await job.updateProgress({ status: "updating", processedItems: done, totalItems: total });
    await WebhookHistory.findByIdAndUpdate(webhookHistoryId, {
      status: "updating",
      processedItems: done,
      totalItems: total,
      bcChannelId: channelId,
    });
  }

  await WebhookHistory.findByIdAndUpdate(webhookHistoryId, {
    status: "done",
    processedItems: done,
    totalItems: total,
    bcChannelId: channelId,
    completedAt: new Date(),
  });
  await job.updateProgress({ status: "done", processedItems: done, totalItems: total });
}

const webhookCruiseControlWorker = new Worker(
  QUEUE_NAMES.webhooks,
  async (job) => {
    const { storeHash, resource, webhookHistoryId } = job.data;
    try {
      const store = await Store.findByHash(storeHash);
      if (!store || !store.is_active) {
        throw new Error("Store not found or not active");
      }
      if (store.plan === "free") {
        await WebhookHistory.findByIdAndUpdate(webhookHistoryId, {
          status: "done",
          completedAt: new Date(),
          error: "Free plan does not support webhooks",
        });
        return;
      }

      if (resource === "products") {
        await processProductWebhook(job, store, webhookHistoryId);
      } else if (resource === "categories") {
        await processCategoryWebhook(job, store, webhookHistoryId);
      } else {
        throw new Error(`Unknown webhook resource: ${resource}`);
      }
    } catch (error) {
      const progress = job.progress || {};
      await job.updateProgress({ ...progress, status: "failed" });
      if (webhookHistoryId) {
        await WebhookHistory.findByIdAndUpdate(webhookHistoryId, {
          status: "failed",
          error: error.message,
          completedAt: new Date(),
          processedItems: progress.processedItems ?? 0,
          totalItems: progress.totalItems ?? 0,
        });
      }
      throw error;
    }
  },
  {
    connection: redis,
    concurrency: 2,
  },
);

module.exports = { webhookCruiseControlWorker };
