const { Router } = require("express");
const { handleProductCreatedWebhook, handleCategoryCreatedWebhook } = require("../controllers/webhookController");

const router = Router();

router.post("/bigcommerce/product/created", handleProductCreatedWebhook);
router.post("/bigcommerce/category/created", handleCategoryCreatedWebhook);

module.exports = router;
