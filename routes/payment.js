const { Router, raw } = require("express");
const { requireAppSession } = require("../middleware/requireAppSession");
const Store = require("../models/Store");
const Plan = require("../models/Plan");
const { syncStoreToIntercom } = require("../services/intercomService");
const { sendPaypalWebhookNotificationEmail, sendPaymentAttemptEmail } = require("../services/emailService");

const router = Router();

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const ENVIRONMENT = process.env.ENVIRONMENT;

const BASE_URL = ENVIRONMENT === "development" ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";

async function getPaypalAccessToken() {
    const credentials = PAYPAL_CLIENT_ID + ":" + PAYPAL_CLIENT_SECRET;
    const auth = Buffer.from(credentials).toString("base64");
  
    const response = await fetch(`${BASE_URL}/v1/oauth2/token`, {
        method: "POST",
        body: "grant_type=client_credentials",
        headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
    });
  const data = await response.json();
  return data.access_token;
}

async function getProPlanAmount() {
  const plan = await Plan.findOne({ name: "pro" });
  if (!plan) {
    throw new Error("Pro plan not configured");
  }
  return Number(plan.price).toFixed(2);
}

router.post("/create-order", requireAppSession, async (req, res) => {
    try {
        const accessToken = await getPaypalAccessToken();
        const totalAmount = await getProPlanAmount();
    
        const response = await fetch(`${BASE_URL}/v2/checkout/orders`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            intent: "CAPTURE",
            purchase_units: [
              {
                amount: {
                  currency_code: "USD",
                  value: totalAmount,
                },
              },
            ],
          }),
        });
    
        const data = await response.json();
        res.status(response.status).json(data);
      } catch (error) {
        console.error("Error creating PayPal order:", error);
        res.status(500).json({ error: error.message });
      }
});

router.post("/capture-order", requireAppSession, async (req, res) => {
  try {
    const { orderID } = req.body;
    const storeHash = req.storeHash;

    const store = await Store.findOne({store_hash: storeHash});
    if (!store) {
      return res.status(400).json({ success: false, message: "Store not found" });
    }
    if (!orderID) {
      return res.status(400).json({ success: false, message: "Missing orderID" });
    }

    const expectedAmount = await getProPlanAmount();
    const accessToken = await getPaypalAccessToken();

    const response = await fetch(`${BASE_URL}/v2/checkout/orders/${orderID}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    const data = await response.json();

    if (response.status !== 200 && response.status !== 201) {
      return res.status(response.status).json({ success: false, message: "Payment capture failed", data });
    }

    if (data.status !== "COMPLETED") {
      return res.status(400).json({ success: false, message: "Payment not completed", data });
    }

    const paid =
      data?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value;

    if (paid !== expectedAmount) {
      return res.status(400).json({
        success: false,
        message: "Payment amount mismatch",
      });
    }

    await Store.findOneAndUpdate(
      { store_hash: storeHash },
      { plan: "pro", planPurchasedAt: new Date() },
    );

    await syncStoreToIntercom(storeHash);

    return res.status(200).json({ success: true, message: "Payment captured successfully", data });
  } catch (error) {
    console.error("Error capturing PayPal order:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Must receive RAW body (not JSON-parsed) for signature verification to work.

router.post("/webhook", raw({ type: "application/json" }), async (req, res) => {
  try {
    // express.json() already parsed the body, so req.body is an object here
    console.log(req.body);
    // return res.status(200).json({ received: true });
    const event = req.body;
    const accessToken = await getPaypalAccessToken();

    const verifyRes = await fetch(`${BASE_URL}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_algo: req.headers["paypal-auth-algo"],
        cert_url: req.headers["paypal-cert-url"],
        transmission_id: req.headers["paypal-transmission-id"],
        transmission_sig: req.headers["paypal-transmission-sig"],
        transmission_time: req.headers["paypal-transmission-time"],
        webhook_id: process.env.PAYPAL_WEBHOOK_ID,
        webhook_event: event,
      }),
    });
    const verification = await verifyRes.json();
    if (verification.verification_status !== "SUCCESS") {
      console.warn("PayPal webhook: invalid signature");
      return res.status(400).json({ error: "invalid signature" });
    }

    if (event.event_type === "BILLING.SUBSCRIPTION.ACTIVATED") {
      console.warn("BILLING.SUBSCRIPTION.ACTIVATED");
      const storeHash = event.resource.custom_id; // the storeHash you passed in create-subscription
      const resource = event.resource || {};
      const subscriber = resource.subscriber || {};
      const [store, plan] = await Promise.all([
        Store.findOneAndUpdate(
          { store_hash: storeHash },
          { plan: "pro", planPurchasedAt: new Date(), paypalSubscriptionId: resource.id },
          { returnDocument: "after" },
        ),
        Plan.findOne({ name: "pro" }).select("price").lean(),
      ]);
      await syncStoreToIntercom(storeHash);
      const lastPayment = resource.billing_info?.last_payment?.amount;
      await sendPaypalWebhookNotificationEmail({
        eventType: event.event_type,
        storeHash,
        storeName: store?.store_name,
        storeEmail: store?.email,
        storeUrl: store?.store_url || store?.store_domain,
        subscriptionId: resource.id,
        planId: resource.plan_id,
        status: resource.status,
        price: lastPayment?.value ?? plan?.price,
        currency: lastPayment?.currency_code || "USD",
        payerEmail: subscriber.email_address,
        payerName: [subscriber.name?.given_name, subscriber.name?.surname].filter(Boolean).join(" "),
        nextBillingTime: resource.billing_info?.next_billing_time,
      });
    }

    const downgradeEvents = [
      "BILLING.SUBSCRIPTION.CANCELLED",
      "BILLING.SUBSCRIPTION.SUSPENDED",
      "BILLING.SUBSCRIPTION.EXPIRED",
    ];
    if (downgradeEvents.includes(event.event_type)) {
      const resource = event.resource || {};
      const subscriber = resource.subscriber || {};
      const store = await Store.findOneAndUpdate(
        { paypalSubscriptionId: resource.id },
        { plan: "free" },
        { returnDocument: "after" },
      );
      if (store?.store_hash) {
        await syncStoreToIntercom(store.store_hash);
      }
      await sendPaypalWebhookNotificationEmail({
        eventType: event.event_type,
        storeHash: store?.store_hash || resource.custom_id,
        storeName: store?.store_name,
        storeEmail: store?.email,
        storeUrl: store?.store_url || store?.store_domain,
        subscriptionId: resource.id,
        planId: resource.plan_id,
        status: resource.status || event.event_type.split(".").pop(),
        price: resource.billing_info?.last_payment?.amount?.value,
        currency: resource.billing_info?.last_payment?.amount?.currency_code || "USD",
        payerEmail: subscriber.email_address,
        payerName: [subscriber.name?.given_name, subscriber.name?.surname].filter(Boolean).join(" "),
        nextBillingTime: resource.billing_info?.next_billing_time,
      });
    }

    // Recurring charge notification only — do not change plan here
    if (event.event_type === "PAYMENT.SALE.COMPLETED") {
      const resource = event.resource || {};
      const subscriptionId = resource.billing_agreement_id || resource.billing_subscription_id || null;
      const store = subscriptionId
        ? await Store.findOne({ paypalSubscriptionId: subscriptionId }).lean()
        : null;
      const amount = resource.amount || {};
      await sendPaypalWebhookNotificationEmail({
        eventType: event.event_type,
        storeHash: store?.store_hash || resource.custom || resource.custom_id,
        storeName: store?.store_name,
        storeEmail: store?.email,
        storeUrl: store?.store_url || store?.store_domain,
        subscriptionId: subscriptionId || resource.id,
        planId: "N/A",
        status: resource.state || resource.status || "completed",
        price: amount.total ?? amount.value,
        currency: amount.currency || amount.currency_code || "USD",
        payerEmail: resource.payer?.email_address || resource.payee?.email,
        payerName: [resource.payer?.name?.given_name, resource.payer?.name?.surname].filter(Boolean).join(" "),
        nextBillingTime: "N/A",
      });
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/create-subscription", requireAppSession, async (req, res) => {
  try {
    const accessToken = await getPaypalAccessToken();
    const plan = await Plan.findOne({ name: "pro" });

    console.log(plan.paypalPlanId,req.storeHash, process.env.FRONTEND_BASE_URL);

    const response = await fetch(`${BASE_URL}/v1/billing/subscriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        plan_id: plan.paypalPlanId,
        custom_id: req.storeHash, // IMPORTANT: this is how you'll match the webhook back to this store
        application_context: {
          return_url: `${process.env.FRONTEND_BASE_URL}/paypal/subscription-return`,
          cancel_url: `${process.env.FRONTEND_BASE_URL}/paypal/subscription-cancel`,
        },
      }),
    });

    const data = await response.json();


    console.log("Create subscription status:", response.status);
console.log("Create subscription response:", JSON.stringify(data, null, 2));

    if (response.ok && data?.id) {
      const store = await Store.findOne({ store_hash: req.storeHash })
        .select("store_name email store_url store_domain")
        .lean();
      // Fire-and-forget: don't delay returning the subscription id to PayPal checkout
      sendPaymentAttemptEmail({
        storeHash: req.storeHash,
        storeName: store?.store_name, 
        storeEmail: store?.email,
        storeUrl: store?.store_url || store?.store_domain,
        subscriptionId: data.id,
        planId: plan?.paypalPlanId,
        price: plan?.price,
        status: data.status,
      });
    }

    res.status(response.status).json(data);
    // frontend needs: data.links.find(l => l.rel === "approve").href
    // → redirect the browser there
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/subscription-status/:id", requireAppSession, async (req, res) => {
  try {
    const store = await Store.findOne({
      store_hash: req.storeHash,
      paypalSubscriptionId: req.params.id,
      plan: "pro",
    }).select("_id").lean();

    return res.status(200).json({
      status: store ? "active" : "pending",
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = {
  router,
  getPaypalAccessToken,
  getProPlanAmount,
};
