const { Router } = require("express");
const { requireAppSession } = require("../middleware/requireAppSession");
const {
  updateBulk,
  updateCruiseControl,
  saveTemplates,
  getAllTemplates,
  getJobStatus,
  getDashboardInfo
} = require("../controllers/bulkController");

const router = Router();

router.post("/update", requireAppSession, updateBulk);
router.post("/cruise-control", requireAppSession, updateCruiseControl);
router.post("/save-templates", requireAppSession, saveTemplates);
router.get("/get-all-templates", requireAppSession, getAllTemplates);
router.post("/get-job-status", requireAppSession, getJobStatus);
router.get("/get-dashboard-info", requireAppSession, getDashboardInfo);

module.exports = router;
