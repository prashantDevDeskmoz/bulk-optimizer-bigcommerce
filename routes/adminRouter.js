const { Router } = require("express");
const jwt = require("jsonwebtoken");
const {
  adminLogin,
  getDashboard,
  getPlans,
  updatePlan,
  getWorkersStatus,
  getClients,
  getClientById,
  getAdminSecret,
} = require("../controllers/adminController");

const router = Router();

const requireAdmin = (req, res, next) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ status: false, message: "Missing admin token" });
    }
    const payload = jwt.verify(token, getAdminSecret());
    if (payload.role !== "admin") {
      return res.status(403).json({ status: false, message: "Forbidden" });
    }
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ status: false, message: "Invalid or expired admin token" });
  }
};

router.post("/login", adminLogin);
router.get("/dashboard", requireAdmin, getDashboard);
router.get("/plans", requireAdmin, getPlans);
router.put("/plans/:id", requireAdmin, updatePlan);
router.get("/workers", requireAdmin, getWorkersStatus);
router.get("/clients", requireAdmin, getClients);
router.get("/clients/:id", requireAdmin, getClientById);

module.exports = router;
