'use strict';

/**
 * GameComponent entrypoint (spec section D recommended stack: Node.js 18).
 *
 * Run:  node services/game/src/server.js   (or npm run start:game)
 * Port: GAME_PORT, default 8081
 */
const { GameComponent } = require('./component');

const component = new GameComponent();

component
  .start()
  .then(() => {
    component.logger.info('GameComponent ready (FR-1 Play game, NFR-1 performance)');
  })
  .catch((err) => {
    component.logger.error({ err: err.message }, 'GameComponent failed to start');
    process.exit(1);
  });

async function shutdown(signal) {
  component.logger.info({ signal }, 'shutting down GameComponent');
  try {
    await component.stop();
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { component };
