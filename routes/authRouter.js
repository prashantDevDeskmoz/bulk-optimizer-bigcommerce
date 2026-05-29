const { Router } = require("express");
const {
  handleAuthCallback,
  createSessionFromLoad,
} = require("../controllers/authController");

const router = Router();

router.get("/callback", handleAuthCallback);
router.post("/verify-jwt", createSessionFromLoad);

module.exports = router;
