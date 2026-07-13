const axios = require("axios");
const Store = require("../models/Store");
const Channel = require("../models/Channel");

const {
  listProductsUrl,
  listTreeCategoriesUrl,
  listTreesUrl,
} = require("../utils/bcApi");

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

module.exports = { getChannelPreviewSamples };
