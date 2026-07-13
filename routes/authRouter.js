const { Router } = require("express");
const {
  handleAuthCallback,
  createSessionFromLoad,
  handleUnInstall,
} = require("../controllers/authController");

const router = Router();

router.get("/callback", handleAuthCallback);
router.post("/verify-jwt", createSessionFromLoad);
router.get("/uninstall", handleUnInstall);

module.exports = router;
