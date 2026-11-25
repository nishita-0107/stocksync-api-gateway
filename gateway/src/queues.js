const { Queue } = require('bullmq');

const QUEUE_NAMES = { logs: 'request-logs' };

function createQueues(connection) {
  return {
    logs: new Queue(QUEUE_NAMES.logs, {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 500 },
        removeOnComplete: true,
        removeOnFail: { count: 1000 },
      },
    }),
  };
}

module.exports = { QUEUE_NAMES, createQueues };
