const path = require("path");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
const { logError } = require("../../utils/logger");

process.on("unhandledRejection", (reason) => {
  logError("Workers: unhandled promise rejection", { error: reason });
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  logError("Workers: uncaught exception", { error });
  process.exit(1);
});

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log("Workers: MongoDB connected");
    const workers = [
      ...Object.values(require("./bulk-optimizer")),  // registers product/category/brand/image workers
      require("./restore"),                           // registers restore worker
      ...Object.values(require("./webhook")),         // registers webhook cruise-control worker
    ];
    workers.forEach((worker) => {
      worker.on("failed", (job, error) => {
        logError("Job failed", { queue: worker.name, jobId: job?.id, storeHash: job?.data?.storeHash, attempts: job?.attemptsMade, error });
      });
    });
    console.log("All workers started");
  })
  .catch((err) => {
    console.error("Workers: MongoDB connection failed", err);
    process.exit(1);
  });
