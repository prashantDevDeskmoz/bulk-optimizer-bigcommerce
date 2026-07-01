const { Router } = require("express");
const Store = require("../models/Store");
const { requireAppSession } = require("../middleware/requireAppSession");
const JobHistory = require("../models/JobHistory");
const Channel = require("../models/Channel");
const axios = require("axios");
const { listBrandsUrl, storeUrl } = require("../utils/bcApi");

const router = Router();

router.get("/", requireAppSession, async (req, res) => {
    try {
        const store = await Store.findByHash(req.storeHash);
        res.status(200).json({
            status: true,
            data: store,
        });
    } catch (error) {
        res.status(500).json({ status: false, message: error.message });
    }
});

router.get('/get-plan', requireAppSession, async (req, res) => {
    try {
        console.log("get-plan", req.storeHash);
        const store = await Store.findByHash(req.storeHash);
        if(!store || store.is_active === false) {
            return res.status(404).json({ status: false, message: "Store not found" });
        }

        const [plan] = await Store.aggregate([
            {$match: {_id: store._id}},
            {$lookup: {
                from: "plans",
                localField: "plan",
                foreignField: "name",
                as: "plan",
            }},
            {$unwind: "$plan"},
            {$project: {_id: 0, plan: 1}},
            {$sort: {createdAt: -1}},
            {$limit: 1},
        ]);

        const [totalOptimizations] = await JobHistory.aggregate([
            {$match: {storeHash: store.store_hash}},
            {$group: {_id: null, total: {$sum: "$processedItems"}}},
            {$project: {_id: 0, total: 1}},
        ]);

        res.status(200).json({
            status: true,
            data: {
                plan : plan,
                totalOptimizations : totalOptimizations?.total || 0,
            },
        });
    } catch (error) {
        console.log("error", error);
        res.status(500).json({ status: false, message: error.message });
    }
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