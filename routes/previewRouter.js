const { Router } = require("express");
const { requireAppSession } = require("../middleware/requireAppSession");
const { getChannelPreviewSamples } = require("../controllers/previewController");

const router = Router();

router.get("/channel-samples", requireAppSession, getChannelPreviewSamples);

module.exports = router;
