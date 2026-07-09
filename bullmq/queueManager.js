const { Queue } = require("bullmq");
const redis = require("../redis");

const QUEUE_NAMES = {
  products:         "bulk-optimized-products-v2",
  categories:       "bulk-optimized-categories",
  brands:           "bulk-optimized-brands",
  images:           "bulk-optimized-images-v2",
  restore:          "bulk-restore",
  restoreImages:    "bulk-restore-images",
};

class QueueManager {
  constructor() {

    const defaultJobOptions = {
      removeOnFail:     { count: 20 },
      removeOnComplete: { count: 10  },
    };
    
    const queueConfig = { connection: redis, defaultJobOptions };
    // Create a separate Queue instance for each resource
    //concurrency limit of 10, remove on failed , remove on complete
    this.queues = {
      [QUEUE_NAMES.products]:           new Queue(QUEUE_NAMES.products, queueConfig),
      [QUEUE_NAMES.categories]:         new Queue(QUEUE_NAMES.categories, queueConfig),
      [QUEUE_NAMES.brands]:             new Queue(QUEUE_NAMES.brands, queueConfig),
      [QUEUE_NAMES.images]:             new Queue(QUEUE_NAMES.images, queueConfig),
      [QUEUE_NAMES.restore]:            new Queue(QUEUE_NAMES.restore, queueConfig),
      [QUEUE_NAMES.restoreImages]:      new Queue(QUEUE_NAMES.restoreImages, queueConfig),
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