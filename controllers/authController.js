const dotenv = require("dotenv");
const axios = require("axios");
const Store = require("../models/Store");
const {
  verifySignedPayloadJwt,
  createAppSessionToken,
  storeHashFromSub,
  SESSION_TTL_SECONDS,
  buildSessionToken,
} = require("../utils/sessionJwt");
const { storeUrl } = require("../utils/bcApi");
const { sendInstallNotificationEmail } = require("../services/emailService");
const { subscribeWebhooksOnInstall } = require("../utils/webhooks");
const { syncStoreChannels } = require("../utils/channelSync");
const handleAuthCallback = async (req, res) => {
  try {
    console.log("Callback received:", req.query);

    // 1. Get the code, scope, and context from the query parameters
    const { code, scope, context } = req.query;

    if (!code || !scope || !context) {
      console.error("❌ Missing required parameters");
      return res.status(400).send("Missing required parameters: code, scope, or context");
    }

    // 2. Exchange the code for an access token
    const tokenResponse = await axios.post(
      "https://login.bigcommerce.com/oauth2/token",
      {
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        code: code,
        scope: scope,
        grant_type: "authorization_code",
        redirect_uri: process.env.AUTH_CALLBACK,
        context: context,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

    const { access_token, user, context: storeContext } = tokenResponse.data;

    console.log("tokenResponse.data--------------------------------", tokenResponse.data);

    // 3. Get the store hash from the context
    const storeHash = storeContext?.split("/")[1];

    // 4. Get the store data from the BigCommerce API
    const { data:storeData } = await axios.get(
      storeUrl(storeHash),
      {
        headers: {
          "X-Auth-Token": access_token,
          Accept: "application/json",
        },
      },
    );

    // 5. Update the store in the database (new: true → upserted/updated doc so we have Mongo _id)
    const store = await Store.findOneAndUpdate(
      { store_hash: storeHash },
      {
        $set: {
          access_token: access_token,
          scope: scope,
          email: user?.email,
          store_name: storeData?.name || null,
          store_domain: storeData?.domain || null,
          store_url: storeData?.url || null,
          platform_version: storeData?.platform_version || null,
          currency: storeData?.currency || null,
          timezone: storeData?.timezone.name || null,
          language: storeData?.language || null,
          is_active: true,
        },
      },
      { upsert: true, returnDocument: "after" },
    );

    // 6. Sync channels from BigCommerce into our DB (needs e.g. store_channel_settings on token)
    try {
      const { count } = await syncStoreChannels(storeHash, access_token, store._id);
      console.log(`✅ Synced ${count} channel(s) for store ${storeHash}`);
    } catch (err) {
      console.error(
        "⚠️ Channel sync on install failed (add Channels scope or check token):",
        err?.response?.data ?? err.message,
      );
    }

    // 7. Subscribe webhooks on install
    await subscribeWebhooksOnInstall(storeHash, access_token);

    // 8. Send install email to the store owner
    await sendInstallNotificationEmail(storeHash, user?.email);

    // 9. App session for the frontend (same shape as load flow; OAuth gives `user`, not JWT payload)
    const sessionToken = buildSessionToken({
      storeHash: storeHash,
      email: user?.email,
      storeId: storeData?.id.toString(),
    });
    const sessionExpiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;

    // 10. Redirect to the install page
    const redirectUrl = new URL("install", process.env.FRONTEND_BASE_URL);
    redirectUrl.searchParams.set("storeHash", storeHash);
    redirectUrl.searchParams.set("storeId", storeData?.id.toString());
    redirectUrl.searchParams.set("sessionToken", sessionToken);
    redirectUrl.searchParams.set("sessionExpiresAt", sessionExpiresAt.toString());
    //set cookie sessionToken
    const cookieOptions = {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/",
      domain : ".shares.zrok.io"
    };
    
    res.cookie("sessionToken", sessionToken, cookieOptions);
    res.cookie("storeId", storeData?.id.toString(), cookieOptions);

    res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta http-equiv="refresh" content="0;url=${redirectUrl.toString()}" />
            <title>Installation Complete</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 60px; }
              .card {
                display: inline-block;
                padding: 32px;
                border-radius: 12px;
                background: #fff;
                box-shadow: 0 10px 30px rgba(0,0,0,0.08);
              }
              .muted { color: #888; font-size: 14px; }
              .success { color: #10b981; font-size: 18px; font-weight: bold; margin-bottom: 16px; }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="success">✓ Installation Successful!</div>
              <h1>Welcome to BULK OPTIMIZER</h1>
              <p>Redirecting you to the setup page...</p>
              <p class="muted">Store: ${storeHash}</p>
            </div>
            <script>
              window.top.location.href = "${redirectUrl.toString()}";
            </script>
          </body>
        </html>
      `);
  } catch (error) {
    console.error("[handleAuthCallback] error:", error.message);
    res.status(500).json({ error: error.message });
  }
};

/**
 * POST /auth/session
 * Body: { signed_payload_jwt: string }
 * Verifies BigCommerce load JWT, ensures store is installed, returns app session JWT (1 day).
 */
const createSessionFromLoad = async (req, res) => {
  try {
    const signed_payload_jwt = req.body?.signed_payload_jwt;

    if (!signed_payload_jwt || typeof signed_payload_jwt !== "string") {
      return res.status(400).json({ status: false, message: "Missing signed_payload_jwt" });
    }

    let bcPayload;
    try {
      bcPayload = verifySignedPayloadJwt(signed_payload_jwt);
    } catch {
      return res.status(401).json({ status: false, message: "Invalid or expired signed_payload_jwt" });
    }

    const storeHash = storeHashFromSub(bcPayload.sub);
    if (!storeHash) {
      return res.status(400).json({ status: false, message: "Invalid store subject in token" });
    }

    const store = await Store.findByHash(storeHash);
    if (!store) {
      return res.status(404).json({ status: false, message: "Store not installed. Please re-install the app on your BigCommerce store." });
    }
    if (!store.is_active) {
      return res.status(403).json({ status: false, message: "Store is not active" });
    }

    const sessionToken = createAppSessionToken({ storeHash, bcPayload });
    const sessionExpiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;

    const cookieOptions = {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/",
      domain : ".shares.zrok.io"
    };

    res.cookie("sessionToken", sessionToken, cookieOptions);

    res.status(200).json({
      status: true,
      message: "Session created successfully",
      sessionToken,
      sessionMaxAgeSeconds: SESSION_TTL_SECONDS,
    });
  } catch (error) {
    console.error("createSessionFromLoad:", error.message);
    res.status(500).json({ status: false, message: error.message });
  }
};

const handleUnInstall = async (req, res) => {
  try {
    const storeHash = req.params.storeHash;
    await Store.findOneAndUpdate({store_hash: storeHash}, {is_active: false});

    res.status(200).json({status: true, message: "Store uninstalled successfully"});
  } catch (error) {
    console.error("handleUnInstall:", error.message);
    res.status(500).json({status: false, message: error.message});
  }
}

module.exports = {
  handleAuthCallback,
  createSessionFromLoad,
  handleUnInstall,
};
