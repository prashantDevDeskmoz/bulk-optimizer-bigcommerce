const crypto = require("crypto");
const axios = require("axios");
const Store = require("../models/Store");
const Template = require("../models/Template");
const WebhookHistory = require("../models/WebhookHistory");

const {
  batchUpdateCategoriesUrl,
  batchUpdateProductsUrl,
  getProductUrl,
  listTreeCategoriesUrl,
  listTreesUrl,
  productChannelAssignmentsUrl,
} = require("../utils/bcApi");

function timingSafeEqual(a, b) {
  try {
    const ba = Buffer.from(String(a), "utf8");
    const bb = Buffer.from(String(b), "utf8");
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

async function updateCategoryCreated({
  target,
  template,
  storeHash,
  categoryId,
  categoryData,
  accessToken,
  storeId,
  bcChannelId,
}) {
  let webhookHistory = null;
  try {
    webhookHistory = await new WebhookHistory({
      storeId,
      resource: "categories",
      target,
      template,
      bcChannelId,
      status: "updating",
      startedAt: new Date(),
    }).save();

    const renderTemplate = (tpl, category) => {
      const dict = {
        "[[category name]]": category?.name ?? "",
      };
      let out = tpl ?? "";
      for (const [token, value] of Object.entries(dict)) {
        out = out.replaceAll(token, value);
      }
      return out;
    };

    const updates = [
      {
        category_id: categoryId,
        ...(target === "title"
          ? { page_title: renderTemplate(template, categoryData) }
          : { meta_description: renderTemplate(template, categoryData) }),
      },
    ];

    await axios.put(batchUpdateCategoriesUrl(storeHash), updates, {
      headers: {
        "X-Auth-Token": accessToken,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    await WebhookHistory.findByIdAndUpdate(webhookHistory._id, {
      status: "done",
      itemName: categoryData?.name ?? "",
      completedAt: new Date(),
    });
    return true;
  } catch (e) {
    console.error("updateCategoryCreated:", e.message);
    if (webhookHistory?._id) {
      await WebhookHistory.findByIdAndUpdate(webhookHistory._id, {
        status: "failed",
        error: e.message,
        itemName: categoryData?.name ?? "",
        completedAt: new Date(),
      });
    }
    return false;
  }
}

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
  let out = template ?? "";
  for (const [token, value] of Object.entries(dict)) {
    out = out.replaceAll(token, value);
  }
  return out;
}

async function getChannelIdsForProduct(storeHash, productId, headers) {
  const { data } = await axios.get(
    productChannelAssignmentsUrl(storeHash),
    {
      headers,
      params: { "product_id:in": productId },
    },
  );
  const assignments = Array.isArray(data?.data) ? data.data : [];
  const channelIds = [
    ...new Set(
      assignments
        .map((row) => row?.channel_id)
        .filter((id) => id != null && id !== ""),
    ),
  ];
  return channelIds;
}

async function updateProductCreated({
  target,
  template,
  storeHash,
  productId,
  productData,
  accessToken,
  storeId,
  bcChannelId,
}) {
  let webhookHistory = null;
  try {
    webhookHistory = await new WebhookHistory({
      storeId,
      resource: "products",
      target,
      template,
      bcChannelId,
      status: "updating",
      startedAt: new Date(),
    }).save();

    const rendered = renderProductTemplate(template, productData);
    const updatePayload =
      target === "title"
        ? { id: productId, page_title: rendered }
        : { id: productId, meta_description: rendered };

    await axios.put(batchUpdateProductsUrl(storeHash), [updatePayload], {
      headers: {
        "X-Auth-Token": accessToken,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    await WebhookHistory.findByIdAndUpdate(webhookHistory._id, {
      status: "done",
      itemName: productData?.name ?? "",
      completedAt: new Date(),
    });
    return true;
  } catch (e) {
    console.error("updateProductCreated:", e.message);
    if (webhookHistory?._id) {
      await WebhookHistory.findByIdAndUpdate(webhookHistory._id, {
        status: "failed",
        error: e.message,
        itemName: productData?.name ?? "",
        completedAt: new Date(),
      });
    }
    return false;
  }
}

/**
 * POST /webhooks/bigcommerce/product
 * BigCommerce notifies here when a product is created (store/product/created).
 */
const handleProductCreatedWebhook = async (req, res) => {
  let parentWebhookHistory = null;
  try {
    const payload = req.body;
    console.log("[webhook] store/product/created", JSON.stringify(payload));

    const storeHash = payload.producer.split("/")[1];
    const productId = payload.data.id;

    const store = await Store.findByHash(storeHash);
    if (!store) {
      console.error("[handleProductCreatedWebhook]: Store not found");
      return res.status(404).json({ status: false, message: "Store not found" });
    }
    if(store.plan === "free") {
      return res.status(200).json({ status: true, message: "Free plan does not support webhooks" });
    }

    parentWebhookHistory = await new WebhookHistory({
      storeId: store._id,
      resource: "products",
      status: "pending",
      startedAt: new Date(),
    }).save();

    const headers = {
      "X-Auth-Token": store.access_token,
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    const { data: productRes } = await axios.get(
      getProductUrl(storeHash, productId),
      { headers },
    );
    const productData = productRes?.data;
    if (!productData?.id) {
      throw new Error("Product not found in catalog");
    }

    const channelIds = await getChannelIdsForProduct(
      storeHash,
      productId,
      headers,
    );
    if (channelIds.length === 0) {
      console.warn("[handleProductCreatedWebhook]: No channel assignments found for product");
      return res.status(200).json({ status: true, message: "No channel assignments found for product" });
    }

    let cruiseItems = [];
    for (const channelId of channelIds) {
      const cruiseTemplates = await Template.find({
        storeId: store._id,
        bcChannelId: String(channelId),
        applyTo: "products",
        target: {$in: ["title", "meta"]},
        cruiseControl: true,
        template: {$ne: null, $ne: ""}
      });

      console.log("[handleProductCreatedWebhook]: Cruise templates:::::::::::::::::::::::::::::::::", cruiseTemplates);

  
      const titleTemplate = cruiseTemplates.find(item => item.target === "title");
      const metaTemplate = cruiseTemplates.find(item => item.target === "meta");

      // only return two items last templates for title and meta
      if(titleTemplate && !cruiseItems.some(t => t.target === "title")) cruiseItems.push(titleTemplate);
      if(metaTemplate && !cruiseItems.some(t => t.target === "meta")) cruiseItems.push(metaTemplate);
    }

    console.log("[handleProductCreatedWebhook]: Cruise items:::::::::::::::::::::::::::::::::", cruiseItems);

    if(cruiseItems.length === 0) {
      console.log("[handleProductCreatedWebhook]: No cruise items found for product");
        return res.status(200).json({ status: true, message: "No cruise items found for product" });
    }

      for (const item of cruiseItems) {
        if (!item.template) {
          console.error("[handleProductCreatedWebhook]: Template missing, skipping", item.bcChannelId, item.target);
          continue;
        }

        console.log("[handleProductCreatedWebhook]: Updating product", item.bcChannelId, item.target);

        const ok = await updateProductCreated({
          target: item.target,
          template: item.template,
          storeHash,
          productId,
          productData,
          accessToken: store.access_token,
          storeId: store._id,
          bcChannelId: item.bcChannelId,
        });
        if (ok) {
          console.log("[handleProductCreatedWebhook]: Product updated successfully", item.bcChannelId, item.target);
        }
      }

      await WebhookHistory.findByIdAndUpdate(parentWebhookHistory._id, {
        status: "done",
        completedAt: new Date(),
      });

    return res.status(200).json({
      status: true,
      message: "Product created webhook received",
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

const handleCategoryCreatedWebhook = async (req, res) => {
  let parentWebhookHistory = null;
  try {
    const payload = req.body;
    console.log("[webhook] store/category/created", JSON.stringify(payload));
    const storeHash = payload.producer.split("/")[1];
    const categoryId = payload.data.id;

    const store = await Store.findByHash(storeHash);
    if (!store) {
      console.error("[handleCategoryCreatedWebhook]: Store not found");
      return res.status(404).json({ status: false, message: "Store not found" });
    }
    if(store.plan === "free") {
      return res.status(200).json({ status: true, message: "Free plan does not support webhooks" });
    }

    parentWebhookHistory = await new WebhookHistory({
      storeId: store._id,
      resource: "categories",
      status: "pending",
      startedAt: new Date(),
    }).save();

    console.log("fetching category data:::::::::::::::::::::::::::::::::", store.access_token);
    // now get channel from category id using bigcommerce api of trees
    const category = await axios.get(listTreeCategoriesUrl(storeHash), {
      headers: {
        "X-Auth-Token": store.access_token,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      params: { "category_id:in": categoryId },
    });
    const categoryData = category.data.data[0];

    // now get channel from tree id using bigcommerce api of trees
    const tree = await axios.get(listTreesUrl(storeHash), {
      headers: {
        "X-Auth-Token": store.access_token,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      params: { "id:in": categoryData.tree_id },
    });

    console.log("tree:::::::::::::::::::::::::::::::::::::", tree.data.data);
    const channelId = tree.data.data[0].channels[0];

    // now get all cruise control statuses for this channel
    const allCruiseControlStatusesForChannel = await Template.find({ storeId: store._id, bcChannelId: channelId, applyTo: "categories"});

    console.log("all :::::::::::::::::::::::::::::::::::::::::", allCruiseControlStatusesForChannel);

    const cruiseItems = allCruiseControlStatusesForChannel.filter(
      (item) =>
        item.cruiseControl &&
        (item.target === "title" || item.target === "meta"),
    );


    for (const item of cruiseItems) {
      if (!item.template) {
        console.error("[handleCategoryCreatedWebhook]: Template not found for channel, skipping", channelId, item.target);
        continue;
      }

      console.log("[handleCategoryCreatedWebhook]: Updating category", channelId, item.target);
      const ok = await updateCategoryCreated({
        target: item.target,
        template: item.template,
        storeHash,
        categoryId,
        categoryData,
        accessToken: store.access_token,
        storeId: store._id,
        bcChannelId: channelId,
      });
      if (ok) {
        console.log("[handleCategoryCreatedWebhook]: Category updated successfully", channelId, item.target);
        await WebhookHistory.findByIdAndUpdate(parentWebhookHistory._id, {
          status: "done",
          completedAt: new Date(),
          bcChannelId: channelId,
        });
      }
    }

    return res.status(200).json({ status: true, message: "Category created webhook received" });
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
  handleCategoryCreatedWebhook
};