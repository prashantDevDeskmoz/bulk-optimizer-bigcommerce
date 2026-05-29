const { Router } = require("express");
const { requireAppSession } = require("../middleware/requireAppSession");
const { getWebhookHistories } = require("../controllers/webhookHistoryController");

const router = Router();

router.get("/", requireAppSession, getWebhookHistories);

module.exports = router;
