const axios = require("axios");
const Channel = require("../models/Channel");

/**
 * Fetches all channels for a store (GET /v3/channels).
 * Requires OAuth scope such as store_channel_settings on the access token.
 */
async function fetchAllBigCommerceChannels(storeHash, accessToken) {
  const response = await axios.get(
    `https://api.bigcommerce.com/stores/${storeHash}/v3/channels`,
    {
      headers: {
        "X-Auth-Token": accessToken,
        Accept: "application/json",
      },
    },
  );

  const rawBatch = Array.isArray(response.data?.data)
    ? response.data.data
    : [];

  return rawBatch.filter(
    (channel) =>
      (channel.status === "active" || channel.status === "prelaunch" || channel.status === "connected") 
        && channel.platform === "bigcommerce"
        && channel.type == "storefront"
  );
}

/** GET /v3/channels/{channel_id}/site → url on success, null otherwise */
async function getChannelSiteUrl(storeHash, accessToken, channelId) {
  try {
    const { data } = await axios.get(
      `https://api.bigcommerce.com/stores/${storeHash}/v3/channels/${channelId}/site`,
      {
        headers: {
          "X-Auth-Token": accessToken,
          Accept: "application/json",
        },
      },
    );
    const d = data?.data;
    if (!d) return null;
    const url = typeof d.url === "string" ? d.url.trim() : "";
    return url || null;
  } catch {
    return null;
  }
}

/**
 * Replaces channel documents for this store with the latest list from BigCommerce.
 * @param {string} storeHash
 * @param {string} accessToken
 * @param {import("mongoose").Types.ObjectId} storeId - Store document _id from MongoDB
 */
async function syncStoreChannels(storeHash, accessToken, storeId) {
  if (!storeId) {
    throw new Error("storeId is required for channel sync");
  }

  const rows = await fetchAllBigCommerceChannels(storeHash, accessToken);

  await Channel.deleteMany({ storeId });

  if (rows.length === 0) {
    return { count: 0 };
  }

  const docs = [];
  for (const ch of rows) {
    const siteUrl = await getChannelSiteUrl(
      storeHash,
      accessToken,
      ch.id,
    );

    docs.push({
      storeId,
      bcChannelId: ch.id,
      name: ch.name ?? "",
      platform: ch.platform ?? "",
      type: ch.type ?? "",
      status: ch.status ?? "",
      is_visible: ch.is_visible !== false,
      icon_url: ch.icon_url ?? null,
      site_url: siteUrl,
    });
  }

  await Channel.insertMany(docs);

  return { count: rows.length };
}

module.exports = {
  syncStoreChannels,
  fetchAllBigCommerceChannels,
};