const { Router } = require("express");
const { requireAppSession } = require("../middleware/requireAppSession");
const { getChannels } = require("../controllers/channelController");


const router = Router();
router.get("/", requireAppSession, getChannels);

module.exports = router;
