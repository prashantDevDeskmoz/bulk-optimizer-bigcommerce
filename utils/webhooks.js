const { default: axios } = require("axios");
const { webhooksUrl } = require("./bcApi");

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
    webhooksUrl(storeHash),
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
      webhooksUrl(storeHash),
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
      webhooksUrl(storeHash),
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

const unsubscribeWebhooksOnUninstall = async (storeHash, accessToken) => {
  if (!accessToken) {
    console.log(`ℹ️ No access token for store ${storeHash}, skipping webhook unsubscription`);
    return;
  }
  
  try {
    console.log(`🔄 Unsubscribing all webhooks for store ${storeHash}...`);
    
    // Use silentOnAuthError: true to handle 401 gracefully during uninstall
    const webhooks = await getWebhooks(storeHash, accessToken, { silentOnAuthError: true });
    
    if (webhooks.length === 0) {
      console.log(`ℹ️ No webhooks to unsubscribe for store ${storeHash}`);
      return;
    }
    
    console.log(`📋 Found ${webhooks.length} webhooks to unsubscribe`);
    
    for (const hook of webhooks) {
      try {
        await deleteWebhook(storeHash, accessToken, hook.id);
        console.log(`✅ Webhook unsubscribed: ${hook.scope} (id: ${hook.id})`);
      } catch (err) {
        // Check if it's a 401 error (token revoked during uninstall)
        const statusCode = err.response?.status || err.status;
        if (statusCode === 401) {
          console.log(`ℹ️ Token revoked during uninstall, BigCommerce will auto-cleanup webhooks`);
          return; // Exit early - no point trying other webhooks
        }
        console.error(`❌ Failed to delete webhook ${hook.id}:`, err.message);
        // Continue with other webhooks even if one fails
      }
    }
    
    console.log(`✅ All webhooks unsubscribed for store ${storeHash}`);
  } catch (err) {
    // Check if it's a 401 error (token revoked during uninstall - expected behavior)
    const statusCode = err.response?.status || err.status;
    if (statusCode === 401) {
      console.log(`ℹ️ Token already revoked during uninstall for store ${storeHash} - BigCommerce will auto-cleanup webhooks`);
      return; // This is expected, not an error
    }
    console.error(`❌ Failed to fetch webhooks on uninstall for store ${storeHash}:`, err.message);
    // Don't throw - continue with uninstall even if webhook deletion fails
  }
};

const deleteWebhook = async (storeHash, accessToken, webhookId) => {
  try {
    console.log(`🔄 Deleting webhook ${webhookId} for store: ${storeHash}`);

    await axios.delete(
      `https://api.bigcommerce.com/stores/${storeHash}/v2/hooks/${webhookId}`,
      {
        headers: {
          "X-Auth-Token": accessToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
    );

    console.log(`✅ Webhook deleted successfully`);
  } catch (error) {
    console.error("❌ Error deleting webhook:", {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
    });
    throw error;
  }
};

module.exports = {
  subscribeWebhooksOnInstall,
  unsubscribeWebhooksOnUninstall,
};