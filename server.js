const dotenv = require("dotenv");
dotenv.config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const apiRouter = require("./routes/index");
const { logError } = require("./utils/logger");


const PORT = process.env.PORT || 3000;
const app = express();

app.use((req, res, next) => {
  const startedAt = Date.now();
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400) res.locals.errorMessage = body?.message || body?.error;
    return json(body);
  };
  res.on("finish", () => {
    if (res.statusCode < 400) return;
    logError("Request failed", {
      method: req.method,
      url: req.originalUrl.split("?")[0],
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      storeHash: req.storeHash,
      ip: req.ip,
      responseMessage: res.locals.errorMessage,
      error: res.locals.error,
    });
  });
  next();
});

app.use(
  cors({
    origin: [
      "http://localhost:4005",
      "http://localhost:4173",
      // "http://localhost:5173",
      process.env.FRONTEND_BASE_URL || "http://localhost:4005",
      process.env.ADMIN_PANEL_URL || "http://localhost:5173",
    ],
    credentials: true,
  })
);
app.use(express.json());
app.use("/", apiRouter);

app.use((err, req, res, next) => {
  res.locals.error = err;
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ message: status < 500 ? err.message : "Internal server error" });
});

process.on("unhandledRejection", (reason) => {
  logError("Unhandled promise rejection", { error: reason });
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  logError("Uncaught exception", { error });
  process.exit(1);
});

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