const { Router } = require("express");
const { requireAppSession } = require("../middleware/requireAppSession");
const { getChannelPreviewSamples, getProductsPreview } = require("../controllers/previewController");

const router = Router();

router.get("/channel-samples", requireAppSession, getChannelPreviewSamples);
router.get("/products", requireAppSession, getProductsPreview);

module.exports = router;
