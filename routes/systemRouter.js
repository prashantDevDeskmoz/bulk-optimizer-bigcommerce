const { Router } = require("express");
const { requireAppSession } = require("../middleware/requireAppSession");
const Store = require("../models/Store");
const axios = require("axios");
const Channel = require("../models/Channel");
const OpenAI = require("openai");

const { listBrandsUrl, storeUrl } = require("../utils/bcApi");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const router = Router();

router.get("/", (req, res) => {
  res.status(200).json({
    status: true,
    message: "System is running",
  });
});

router.get("/store", requireAppSession, async (req, res) => {
  try {
    const store = await Store.findByHash(req.storeHash);
    if (!store) {return res.status(404).json({ status: false, message: "Store not found" });}
    const channel = await Channel.find({ store: store._id });
    if (!channel) {return res.status(404).json({ status: false, message: "Channel not found" });}

    const headers = {
      Accept: "application/json",
      "X-Auth-Token": store.access_token,
    };

    const [{ data }, brandResponse] = await Promise.all([
      axios.get(storeUrl(req.storeHash), { headers }),
      axios.get(listBrandsUrl(req.storeHash), {headers, params: { page: 1, limit: 1 },}),
    ]);

    const brands = Array.isArray(brandResponse?.data?.data)
      ? brandResponse.data.data
      : [];
    const brand = brands[0] ?? null;

    return res.status(200).json({
      status: true,
      data: {
        store_name: data.name ?? null,
        store_domain: data.domain ?? null,
        store_url: data.secure_url ?? data.domain ?? null,
        currency: data.currency ?? null,
        brand,
      },
    });
  } catch (error) {
    const status = error.response?.status;
    const bc = error.response?.data;
    console.error("GET /store:", error.message, bc || "");
    return res
      .status(status && status >= 400 && status < 600 ? status : 500)
      .json({ status: false, message: bc?.title || bc?.message || error.message });
  }
});

module.exports = router;
