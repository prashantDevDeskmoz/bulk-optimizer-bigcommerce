const { Router } = require("express");
const { handleProductCreatedWebhook, handleCategoryCreatedWebhook } = require("../controllers/webhookController");

const router = Router();

router.post("/bigcommerce/product", handleProductCreatedWebhook);
router.post("/bigcommerce/category", handleCategoryCreatedWebhook);

module.exports = router;
