const { Router } = require("express");
const { requireAppSession } = require("../middleware/requireAppSession");
const { getWebhookHistories, restoreWebhookHistory } = require("../controllers/webhookHistoryController");

const router = Router();

router.get("/", requireAppSession, getWebhookHistories);
router.post("/restore", requireAppSession, restoreWebhookHistory);

module.exports = router;
