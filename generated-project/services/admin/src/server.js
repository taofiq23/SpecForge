'use strict';

/**
 * Optional standalone AdminComponent entrypoint.
 *
 *   node services/admin/src/server.js      (or: ADMIN_PORT=8084 node ...)
 *
 * By default AdminComponent is hosted inside GameComponent (see component.js),
 * which is how the ComponentDiagram's `GameComponent -- AdminComponent` edge is
 * satisfied. This entry point exists so the admin surface can also be deployed
 * as its own process if it needs to scale independently.
 */
const { AdminComponent } = require('./component');

const component = new AdminComponent();

component
  .start()
  .then(() => {
    component.logger.info('AdminComponent ready (UseCaseDiagram: Update Questions)');
  })
  .catch((err) => {
    component.logger.error({ err: err.message }, 'AdminComponent failed to start');
    process.exit(1);
  });

async function shutdown(signal) {
  component.logger.info({ signal }, 'shutting down AdminComponent');
  try {
    await component.stop();
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { component };
