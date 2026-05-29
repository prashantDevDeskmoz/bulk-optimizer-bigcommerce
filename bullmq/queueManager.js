const { Queue } = require("bullmq");
const redis = require("../redis");

const QUEUE_NAMES = {
  products:   "bulk-optimized-products",
  categories: "bulk-optimized-categories",
  brands:     "bulk-optimized-brands",
};

class QueueManager {
  constructor() {

    const defaultJobOptions = {
      removeOnFail:     { count: 20 },
      removeOnComplete: { count: 10  },
      backoff:          { type: "exponential", delay: 1000 },
      attempts:         3,
    };
    
    const queueConfig = { connection: redis, defaultJobOptions };
    // Create a separate Queue instance for each resource
    //concurrency limit of 10, remove on failed , remove on complete
    this.queues = {
      [QUEUE_NAMES.products]:   new Queue(QUEUE_NAMES.products, queueConfig),
      [QUEUE_NAMES.categories]: new Queue(QUEUE_NAMES.categories, queueConfig),
      [QUEUE_NAMES.brands]:     new Queue(QUEUE_NAMES.brands, queueConfig),
    };
  }

  async addJob(queueName, jobData, options = {}) {
    const queue = this.queues[queueName];
    if (!queue) throw new Error(`Unknown queue: "${queueName}"`);
    return await queue.add(queueName, jobData, options);
  }

  async getJob(queueName, jobId) {
    const queue = this.queues[queueName];
    if (!queue) throw new Error(`Unknown queue: "${queueName}"`);
    return await queue.getJob(jobId);
  }
}

module.exports = {QueueManager, QUEUE_NAMES};