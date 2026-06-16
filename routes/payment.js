const { Router } = require("express");
const { requireAppSession } = require("../middleware/requireAppSession");
const Store = require("../models/Store");

const router = Router();

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const BASE_URL = "https://api-m.sandbox.paypal.com"; // Use https://api-m.paypal.com for production

async function getPaypalAccessToken() {
    const credentials = PAYPAL_CLIENT_ID + ":" + PAYPAL_CLIENT_SECRET;
    const auth = Buffer.from(credentials).toString("base64");
    console.log("auth", auth);
  
    const response = await fetch(`${BASE_URL}/v1/oauth2/token`, {
        method: "POST",
        body: "grant_type=client_credentials",
        headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
    });
  console.log("response", response);
  const data = await response.json();
  return data.access_token;
}


router.post("/create-order", requireAppSession, async (req, res) => {
    try {
        console.log("req.body", req.body);
        const accessToken = await getPaypalAccessToken();

        console.log("accessToken", accessToken);
        
        // Calculate your cart total on the backend to prevent tampering!
        const totalAmount = req.body.amount; 
    
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
        res.status(response.status).json(data); // Sends the Order ID back to Next.js
      } catch (error) {
        console.error("Error creating PayPal order:", error);
        res.status(500).json({ error: error.message });
      }
});

router.post("/capture-order", requireAppSession, async (req, res) => {
  try {
    const { orderID } = req.body;
    const storeHash = req.storeHash;

    console.log("storeHash", storeHash);
    const store = await Store.findOne({store_hash: storeHash});
    if (!store) {
      return res.status(400).json({ success: false, message: "Store not found" });
    }
    if (!orderID) {
      return res.status(400).json({ success: false, message: "Missing orderID" });
    }

    const accessToken = await getPaypalAccessToken();

    // Call PayPal to capture the funds
    const response = await fetch(`${BASE_URL}/v2/checkout/orders/${orderID}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    const data = await response.json();

    // PayPal returns a 201 Created or 200 OK status on a successful capture
    if (response.status === 200 || response.status === 201) {
      if (data.status === "COMPLETED") {
        
        Store.findOneAndUpdate({store_hash: storeHash}, {
            plan: "pro",
            planPurchasedAt: new Date(),
        }).then((result) => {
          console.log("result", result);
          return res.status(200).json({ success: true, message: "Payment captured successfully", data });
        }).catch((error) => {
          console.error("Error updating store:", error);
          return res.status(500).json({ success: false, error: error.message });
        });  
      }
    }

  } catch (error) {
    console.error("Error capturing PayPal order:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;