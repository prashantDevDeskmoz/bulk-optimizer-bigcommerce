const axios = require("axios");
const crypto = require("crypto");
const Store = require("../models/Store");
const Plan = require("../models/Plan");

const INTERCOM_USERS_URL = "https://api.intercom.io/users";

/** Prefix so Bulk Optimizer contacts never collide with SEOKart numeric user_ids in the same workspace */
const INTERCOM_USER_ID_PREFIX = "bo_";

/**
 * Namespaced Intercom user_id for this app, e.g. bo_nlrg4p9hic
 */
const getIntercomUserId = (storeHash) => {
  if (!storeHash) return null;
  return `${INTERCOM_USER_ID_PREFIX}${storeHash}`;
};

/**
 * Messenger identity: user_id + HMAC user_hash (must use same string as REST sync).
 */
const buildIntercomIdentity = (storeHash) => {
  const secret = process.env.INTERCOM_IDENTITY_SECRET;
  const userId = getIntercomUserId(storeHash);
  if (!secret || !userId) return null;
  return {
    user_id: userId,
    user_hash: crypto.createHmac("sha256", secret).update(userId).digest("hex"),
  };
};

/**
 * Sync a store contact to Intercom (Laravel addDataToIntercom equivalent).
 * Uses Intercom REST access token — not the Messenger identity-verification secret.
 */
const syncStoreToIntercom = async (storeHash) => {
  const token = process.env.INTERCOM_ACCESS_TOKEN;
  if (!token) {
    console.warn("syncStoreToIntercom: INTERCOM_ACCESS_TOKEN not set, skipping");
    return false;
  }
  if (!storeHash) {
    console.warn("syncStoreToIntercom: missing storeHash");
    return false;
  }

  const intercomUserId = getIntercomUserId(storeHash);

  try {
    const store = await Store.findByHash(storeHash);
    if (!store) {
      console.warn("syncStoreToIntercom: store not found", storeHash);
      return false;
    }

    const planDoc = await Plan.findOne({ name: store.plan || "free" }).lean();
    const planName = store.plan || "free";
    const planPrice = planDoc?.price != null ? Number(planDoc.price) : 0;
    const isPro = planName === "pro";
    const installStatus = store.is_active ? "installed" : "uninstall";
    const paidUser = isPro ? "Yes" : "No";
    const planLabel = isPro ? `US$ ${planPrice}` : "US$ 0";

    const appId = process.env.BIGCOMMERCE_APP_ID;
    const appUrl = appId
      ? `https://store-${storeHash}.mybigcommerce.com/manage/app/${appId}`
      : store.store_url || "";

    const customAttributes = {
      Product: "Bulk Optimizer",
      "store hash": storeHash,
      email: store.email || "",
      "uninstall/install status": installStatus,
      Platform: "BigCommerce",
      "Store name": store.store_name || "",
      "Store domain": store.store_domain || "",
      "App url": appUrl,
      "Store status": store.is_active ? "active" : "inactive",
      "Paid User": paidUser,
      Plan: planLabel,
      "Plan name": planName,
      "Payment status": isPro ? "paid" : "free",
    };

    await axios.post(
      INTERCOM_USERS_URL,
      {
        user_id: intercomUserId,
        email: store.email || undefined,
        name: store.store_name || undefined,
        custom_attributes: customAttributes,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        timeout: 15000,
      },
    );

    console.log("syncStoreToIntercom: synced", intercomUserId, installStatus, planName);
    return true;
  } catch (error) {
    const detail = error?.response?.data || error.message;
    console.error("syncStoreToIntercom:", detail);
    return false;
  }
};

module.exports = {
  INTERCOM_USER_ID_PREFIX,
  getIntercomUserId,
  buildIntercomIdentity,
  syncStoreToIntercom,
};
