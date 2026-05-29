const { default: axios } = require("axios");

const WEBHOOK_SCOPES = ["store/product/created", "store/category/created"];


const subscribeWebhooksOnInstall = async (storeHash, accessToken) => {
  try {
  const baseUrl = process.env.BACKEND_URL || process.env.WEBHOOK_BASE_URL;
  if (!baseUrl) {
    console.warn(
      "⚠️ WEBHOOK_BASE_URL (or BACKEND_URL) not set — skipping webhook subscription",
    );
    return;
  }

  //getting existing webhooks
  const response = await axios.get(
    `https://api.bigcommerce.com/stores/${storeHash}/v2/hooks`,
    {
      headers: {
        "X-Auth-Token": accessToken,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    }
  );


  for (const scope of WEBHOOK_SCOPES) {
    const destination = `${baseUrl}/webhooks/bigcommerce/${scope.split("/")[1]}`;
    try {
      await createWebhook(storeHash, accessToken, scope, destination);
      console.log(`✅ Webhook subscribed on install: ${scope}`);
    } catch (err) {
      console.error(
        `❌ Failed to subscribe webhook ${scope} on install:`,
        err.message,
      );
    }
  }
} catch (error) {
  console.error("subscribeWebhooksOnInstall:", error.message);
  throw error;
}
};

const createWebhook = async (storeHash, accessToken, scope, destination) => {
  try {
    console.log(`🔄 Creating webhook for scope: ${scope}`);

    const response = await axios.post(
      `https://api.bigcommerce.com/stores/${storeHash}/v2/hooks`,
      {
        scope: scope,
        destination: destination,
        is_active: true,
      },
      {
        headers: {
          "X-Auth-Token": accessToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
    );

    console.log(`✅ Webhook created successfully:`, response.data.id);
    return response.data;
  } catch (error) {
    console.error("❌ Error creating webhook:", {message: error.message});
    throw error;
  }
};

const getWebhooks = async (storeHash, accessToken) => {
  try {
    const response = await axios.get(
      `https://api.bigcommerce.com/stores/${storeHash}/v2/hooks`,
      {
        headers: {
          "X-Auth-Token": accessToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
    );

    console.log("response------->>>>>>>>>>>>>>>-", response.data);
    return response.data;
  } catch (error) {
    console.error("❌ Error getting webhooks:", {message: error.message});
    throw error;
  }
}

module.exports = {
  subscribeWebhooksOnInstall,
};