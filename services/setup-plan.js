const dotenv = require("dotenv");
const path = require("path");
dotenv.config({ path: path.resolve(__dirname, "../.env") });
const { getPaypalAccessToken } = require("../routes/payment");

const BASE_URL = process.env.ENVIRONMENT === "development" ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
// setup-plan.js — run this ONCE (node setup-plan.js), not part of your app's request flow

async function setup() {
    const accessToken = await getPaypalAccessToken();
  
    console.log("BASE_URL:", BASE_URL, process.env.ENVIRONMENT);
    // 1. Create a product
    const productRes = await fetch(`${BASE_URL}/v1/catalogs/products`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Pro Plan", type: "SERVICE", category: "SOFTWARE" }),
    });
    const product = await productRes.json();
    console.log("PRODUCT_ID:", product.id);
  
    // 2. Create a billing plan under that product
    const planRes = await fetch(`${BASE_URL}/v1/billing/plans`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        product_id: product.id,
        name: "Bulk Optimizer Pro Monthly",
        billing_cycles: [{
          frequency: { interval_unit: "MONTH", interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles: 0, // 0 = never stops on its own
          pricing_scheme: { fixed_price: { value: "20.00", currency_code: "USD" } },
        }],
        payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
      }),
    });
    const plan = await planRes.json();
    console.log("PLAN_ID:", plan.id); // <-- paste this into your Plan model in DB
  }

  async function getPlan() {
    const accessToken = await getPaypalAccessToken();
    const planRes = await fetch(`${BASE_URL}/v1/billing/plans/P-8BK228967Y1778814NJLBCJY`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    });
    const plan = await planRes.json();
    console.log("PLAN:", plan);
  }

  async function getSubscriptions() {
    const accessToken = await getPaypalAccessToken();
    const subscriptionsRes = await fetch(`${BASE_URL}/v1/billing/subscriptions/I-AP6AM4MN996Y`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    });
    const subscriptions = await subscriptionsRes.json();
    console.log("SUBSCRIPTIONS:", subscriptions);
  }

  getSubscriptions();