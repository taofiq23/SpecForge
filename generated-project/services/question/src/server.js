'use strict';

/**
 * QuestionComponent entrypoint.
 *
 * Run:  node services/question/src/server.js   (or npm run start:question)
 * Port: QUESTION_PORT, default 8082
 *
 * ASR-1 (data durability) is served here: PostgreSQL persistence with a
 * replication/backup posture exposed at GET /api/v1/durability.
 */
const { QuestionComponent } = require('./component');

const component = new QuestionComponent();

component
  .start()
  .then(() => {
    component.logger.info('QuestionComponent ready (ASR-1 data durability)');
  })
  .catch((err) => {
    component.logger.error({ err: err.message }, 'QuestionComponent failed to start');
    process.exit(1);
  });

async function shutdown(signal) {
  component.logger.info({ signal }, 'shutting down QuestionComponent');
  try {
    await component.stop();
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { component };
