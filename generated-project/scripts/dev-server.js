'use strict';

/**
 * Runs GameComponent (with AdminComponent mounted) against in-memory fakes for
 * PostgreSQL/Redis/RabbitMQ/QuestionComponent, on a fixed port, and stays running - so the
 * UI can be opened in a real browser (http://127.0.0.1:4000) without Docker or any real
 * infrastructure. This is the same boot path scripts/smoke-ui.js exercises over HTTP; this
 * version just keeps the server up instead of asserting against it and exiting.
 *
 *   node scripts/dev-server.js
 */
const shared = require('../shared/src');
const config = require('../shared/src/config');
const { GameComponent } = require('../services/game/src/component');
const { GameService } = require('../services/game/src/service/gameService');
const { GameRepository } = require('../services/game/src/repository/gameRepository');
const { AdminComponent } = require('../services/admin/src/component');
const {
  FakePgPool,
  FakeRedisClient,
  createFakeCache,
  createFakeMessaging,
  createFakeQuestionClient,
} = require('../tests/helpers/fakes');
const { silentLogger } = require('../tests/helpers/http');

const QUESTIONS = [
  { id: 'seed-1', prompt: 'What is 1/2 + 1/4?', options: ['2/6', '3/4', '1/6'], correctOption: '3/4', difficulty: 'easy', weight: 1 },
  { id: 'seed-2', prompt: 'What is 2/3 - 1/6?', options: ['1/3', '1/2', '1/6'], correctOption: '1/2', difficulty: 'easy', weight: 1 },
  { id: 'seed-3', prompt: 'Simplify 18/24.', options: ['2/3', '3/4', '9/12'], correctOption: '3/4', difficulty: 'medium', weight: 1.5 },
];

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

async function main() {
  const pool = new FakePgPool();
  const redis = new FakeRedisClient();
  const metrics = shared.observability.createMetrics('GameComponent');
  const messaging = createFakeMessaging();
  const cache = createFakeCache(redis);
  const repository = new GameRepository({ pool, cache, logger: silentLogger, schema: 'game', metrics });
  const questionClient = createFakeQuestionClient({ questions: QUESTIONS });
  questionClient.call = async (p, opts = {}) => ({ proxied: true, path: p, method: opts.method });

  const service = new GameService({ repository, questionClient, messaging, metrics, logger: silentLogger, config });
  const adminComponent = new AdminComponent({ logger: silentLogger, metrics, questionClient, gameService: service });

  const component = new GameComponent({
    logger: silentLogger,
    metrics,
    pool,
    redis,
    cache,
    messaging,
    repository,
    questionClient,
    service,
    adminComponent,
    config: { ...config, webUiEnabled: true },
  });

  component.app.listen(PORT, '127.0.0.1', () => {
    console.log(`Space Fractions dev server (in-memory, no Docker) running:`);
    console.log(`  Game:  http://127.0.0.1:${PORT}/`);
    console.log(`  Admin: http://127.0.0.1:${PORT}/admin`);
    console.log(`Press Ctrl+C to stop.`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
