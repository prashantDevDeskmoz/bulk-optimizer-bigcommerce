const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const apiRouter = require("./routes/index");

dotenv.config();

const PORT = process.env.PORT || 3000;
const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_BASE_URL || true,
    credentials: true,
  })
);
app.use(express.json());
app.use("/", apiRouter);

const mongoUri = process.env.MONGO_URI;

mongoose.connect(mongoUri)
  .then(() => {
    console.log("🔗 Connected to MongoDB");
    app.listen(PORT, () => {
      console.log(`🚀 BigCommerce App Server Started on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });