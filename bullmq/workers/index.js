const path = require("path");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log("Workers: MongoDB connected");
    require("./bulk-optimizer");  // registers product/category/brand/image workers
    require("./restore");         // registers restore worker
    require("./webhook");         // registers webhook cruise-control worker
    console.log("All workers started");
  })
  .catch((err) => {
    console.error("Workers: MongoDB connection failed", err);
    process.exit(1);
  });

