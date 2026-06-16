const { Router } = require("express");
const { requireAppSession } = require("../middleware/requireAppSession");
const {
  getRestoreItems,
  getRestoreHistory,
  restoreItems,
  bulkRestore,
  getRestoreJobs,
} = require("../controllers/restoreController");

const router = Router();

router.post("/getItems", requireAppSession, getRestoreItems);
router.get("/history", requireAppSession, getRestoreHistory);
router.post("/restore-items", requireAppSession, restoreItems);
router.post("/bulk-restore", requireAppSession, bulkRestore);
router.post("/getRestoreJobs", requireAppSession, getRestoreJobs);

module.exports = router;
