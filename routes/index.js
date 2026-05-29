const { Router } = require("express");
const authRouter = require("./authRouter");
const systemRouter = require("./systemRouter");
const bulkRouter = require("./bulkRouter");
const channelRouter = require("./channelRouter");
const previewRouter = require("./previewRouter");
const webhookRouter = require("./webhookRouter");
const jobHistoryRouter = require("./jobHistoryRouter");
const webhookHistoryRouter = require("./webhookHistoryRouter");

const router = Router();

router.use("/", systemRouter);
router.use("/auth", authRouter);
router.use("/webhooks", webhookRouter);
router.use("/bulk", bulkRouter);
router.use("/channels", channelRouter);
router.use("/preview", previewRouter);
router.use("/job-histories", jobHistoryRouter);
router.use("/webhook-histories", webhookHistoryRouter);

module.exports = router;
