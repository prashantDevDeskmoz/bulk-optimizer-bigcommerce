const axios = require("axios");
const Store = require("../models/Store");
const Channel = require("../models/Channel");
const Template = require("../models/Template");
const { templateRenderer } = require("../bullmq/workerService");

const {
  listBrandsUrl,
  listProductsUrl,
  listTreeCategoriesUrl,
  listTreesUrl,
} = require("../utils/bcApi");

const PRODUCT_SORTS = {
  latest: { sort: "id", direction: "desc" },
  oldest: { sort: "id", direction: "asc" },
  name: { sort: "name", direction: "asc" },
};

async function fetchTreeIdsForChannel(storeHash, bcChannelId, headers) {
  const { data } = await axios.get(listTreesUrl(storeHash), {
    headers,
    params: { "channel_id:in": bcChannelId },
  });
  const trees = Array.isArray(data?.data) ? data.data : [];
  return trees
    .map((tree) => tree?.id)
    .filter((id) => id != null && id !== "");
}

/**
 * GET /preview/channel-samples?bcChannelId=
 * One category from the channel's catalog tree + one product (scoped to channel when supported).
 */
const getChannelPreviewSamples = async (req, res) => {
  try {
    const bcChannelId = req.query.bcChannelId;
    if (!bcChannelId || bcChannelId === "") {
      return res.status(400).json({
        status: false,
        message: "bcChannelId query parameter is required",
      });
    }

    const store = await Store.findByHash(req.storeHash);
    if (!store) {
      return res.status(404).json({ status: false, message: "Store not found" });
    }

    const accessToken =
      typeof store.access_token === "string" ? store.access_token.trim() : "";
    if (!accessToken) {
      return res.status(401).json({
        status: false,
        message: "No OAuth access_token for this store",
      });
    }

    const channel = await Channel.findOne({
      storeId: store._id,
      bcChannelId,
    });
    if (!channel) {
      return res.status(404).json({ status: false, message: "Channel not found" });
    }

    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Auth-Token": accessToken,
    };
    // fetch category start ----------------
    const treeIds = await fetchTreeIdsForChannel(
      req.storeHash,
      bcChannelId,
      headers,
    );

    let category = null;
    if (treeIds.length > 0) {
      const { data } = await axios.get(listTreeCategoriesUrl(req.storeHash), {
        headers,
        params: {
          page: 1,
          limit: 20,
          "tree_id:in": treeIds.join(","),
        },
      });

      category = data.data.find(category => category.page_title != "" && category.meta_description != "");

      const rows = Array.isArray(data?.data) ? data.data : [];
      category = category ?? rows[0] ?? null;
    }

    // fetch product start ----------------
    let product = null;
    let productImage = null;
    try {
      const { data } = await axios.get(listProductsUrl(req.storeHash), {
          headers,
          params: {
            page: 1,
            limit: 20,
            "channel_id:in": bcChannelId,
            include: "images",
        },
      });

      product = data.data.find(product => product.page_title != "" && product.meta_description != "");
      productImage = data.data.find(product => product.images && product.images.length > 0 && product.images.some(image => image.description && image.description != "" ));

      const rows = Array.isArray(data?.data) ? data.data : [];
      product = product ?? rows[0] ?? null;
      productImage = productImage ?? rows[0] ?? null;
    } catch {
      /* channel filter may be unsupported — fall back */
    }

    if (!product) {
      const { data } = await axios.get(listProductsUrl(req.storeHash), {
        headers,
        params: { page: 1, limit: 1, include: "images" },
      });
      const rows = Array.isArray(data?.data) ? data.data : [];
      product = rows[0] ?? null;
    }

    return res.status(200).json({
      status: true,
      data: { product, category, productImage },
    });
  } catch (error) {
    const status = error.response?.status;
    const bc = error.response?.data;
    console.error("getChannelPreviewSamples:", error.message, bc || "");
    return res
      .status(status && status >= 400 && status < 600 ? status : 500)
      .json({
        status: false,
        message: bc?.title || bc?.message || error.message,
      });
  }
};

/**
 * GET /preview/products?bcChannelId=&page=&limit=&search=&sort=
 * One page of channel products with current SEO and what the saved templates would set.
 */
const getProductsPreview = async (req, res) => {
  try {
    const { bcChannelId, search = "", sort = "latest" } = req.query;
    if (!bcChannelId) {
      return res.status(400).json({ status: false, message: "bcChannelId query parameter is required" });
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));

    const store = await Store.findByHash(req.storeHash);
    if (!store?.access_token) {
      return res.status(404).json({ status: false, message: "Store not found" });
    }

    const templates = await Template.find({
      storeId: store._id,
      bcChannelId: String(bcChannelId),
      applyTo: "products",
      target: { $in: ["title", "meta"] },
    })
      .select("target template isDefault")
      .lean();
    const titleTemplate = templates.find((t) => t.target === "title");
    const metaTemplate = templates.find((t) => t.target === "meta");

    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Auth-Token": store.access_token,
    };

    const { data } = await axios.get(listProductsUrl(req.storeHash, "primary_image"), {
      headers,
      params: {
        page,
        limit,
        "channel_id:in": bcChannelId,
        include_fields: "id,name,sku,price,type,brand_id,mpn,condition,page_title,meta_description,custom_url",
        ...(search.trim() ? { keyword: search.trim() } : {}),
        ...(PRODUCT_SORTS[sort] ?? PRODUCT_SORTS.latest),
      },
    });
    const products = Array.isArray(data?.data) ? data.data : [];

    const usesBrand = [titleTemplate, metaTemplate].some((t) => t?.template?.includes("[[brand]]"));
    const brandIds = usesBrand ? [...new Set(products.map((p) => p.brand_id).filter(Boolean))] : [];
    if (brandIds.length > 0) {
      const { data: brandData } = await axios.get(listBrandsUrl(req.storeHash), {
        headers,
        params: { "id:in": brandIds.join(","), limit: brandIds.length, include_fields: "id,name" },
      });
      const brandNameById = Object.fromEntries((brandData?.data ?? []).map((b) => [b.id, b.name ?? ""]));
      for (const product of products) {
        product.brand_name = brandNameById[product.brand_id] ?? "";
      }
    }

    const storeName = titleTemplate?.isDefault ? store.store_name : null;
    const rows = products.map((product) => ({
      id: product.id,
      name: product.name ?? "",
      sku: product.sku ?? "",
      imageUrl: product.primary_image?.url_thumbnail ?? "",
      pageUrl: product.custom_url?.url ?? "",
      currentTitle: product.page_title ?? "",
      currentMeta: product.meta_description ?? "",
      templateTitle: titleTemplate?.template ? templateRenderer(titleTemplate.template, product, "product", storeName) : "",
      templateMeta: metaTemplate?.template ? templateRenderer(metaTemplate.template, product, "product") : "",
    }));

    return res.status(200).json({
      status: true,
      data: rows,
      total: data?.meta?.pagination?.total ?? rows.length,
      page,
      limit,
    });
  } catch (error) {
    const status = error.response?.status;
    const bc = error.response?.data;
    console.error("getProductsPreview:", error.message, bc || "");
    return res
      .status(status && status >= 400 && status < 600 ? status : 500)
      .json({ status: false, message: bc?.title || bc?.message || error.message });
  }
};

module.exports = { getChannelPreviewSamples, getProductsPreview };
