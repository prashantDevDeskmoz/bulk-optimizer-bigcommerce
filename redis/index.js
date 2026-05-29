const Redis = require("ioredis");

const redis = new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || "",
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
});


redis.on("connect", () => {
    console.log("Connected to Redis");
});

redis.on("error", (error) => {
    console.error("Redis error:", error);
});

module.exports = redis;