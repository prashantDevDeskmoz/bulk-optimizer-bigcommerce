const { Router } = require("express");
const { requireAppSession } = require("../middleware/requireAppSession");
const Store = require("../models/Store");
const Plan = require("../models/Plan");

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

    return res.status(200).json({ success: true, message: "Payment captured successfully", data });
  } catch (error) {
    console.error("Error capturing PayPal order:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
