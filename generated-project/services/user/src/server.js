'use strict';

/**
 * UserComponent entrypoint.
 *
 * Run:  node services/user/src/server.js   (or npm run start:user)
 * Port: USER_PORT, default 8083
 *
 * Hosts the OAuth2 token endpoint at POST /oauth/token (section F).
 */
const { UserComponent } = require('./component');

const component = new UserComponent();

component
  .start()
  .then(() => {
    component.logger.info('UserComponent ready (OAuth2 authn/authz, ASR-2 security)');
  })
  .catch((err) => {
    component.logger.error({ err: err.message }, 'UserComponent failed to start');
    process.exit(1);
  });

async function shutdown(signal) {
  component.logger.info({ signal }, 'shutting down UserComponent');
  try {
    await component.stop();
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { component };
