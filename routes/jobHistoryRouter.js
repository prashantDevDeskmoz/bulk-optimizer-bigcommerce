const { Router } = require("express");
const { requireAppSession } = require("../middleware/requireAppSession");
const { getJobHistories } = require("../controllers/jobHistoryController");

const router = Router();

router.get("/", requireAppSession, getJobHistories);

module.exports = router;
