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
      process.env.FRONTEND_BASE_URL || "http://localhost:4005",
    ],
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