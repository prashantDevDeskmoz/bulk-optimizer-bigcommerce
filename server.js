const dotenv = require("dotenv");
dotenv.config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const apiRouter = require("./routes/index");


const PORT = process.env.PORT || 3000;
const app = express();

app.use(
  cors({
    origin: [
      // "http://localhost:4005",
      // "http://localhost:5173",
      process.env.FRONTEND_BASE_URL || "http://localhost:4005",
      process.env.ADMIN_PANEL_URL || "http://localhost:5173",
    ],
    credentials: true,
  })
);
app.use(express.json());
app.use("/", apiRouter);

const mongoUri = process.env.MONGO_URI;

const { ensureDefaultPlans } = require("./services/planService");

mongoose.connect(mongoUri)
  .then(async () => {
    console.log("🔗 Connected to MongoDB");
    await ensureDefaultPlans();
    app.listen(PORT, () => {
      console.log(`🚀 BigCommerce App Server Started on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });