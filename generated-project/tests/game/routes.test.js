'use strict';

/**
 * GameComponent HTTP contract tests.
 *
 * Verifies the routes the component actually serves against openapi.yaml:
 *   - GET /play                    (spec-verbatim path from section D/L)
 *   - GET /health, /ready, /metrics (section E probes, section G observability)
 *   - /api/v1/games*               (FR-1, SequenceDiagram1, StateDiagram)
 *   - /api/v1/help                 (UseCaseDiagram ViewHelp)
 *   - /admin/*                     (ComponentDiagram GameComponent -- AdminComponent)
 */
const { createApp } = require('../../shared/src/http/app');
const { createGameRoutes } = require('../../services/game/src/routes/gameRoutes');
const { createAdminRoutes, ADMIN_BASE_PATH } = require('../../services/game/src/routes/adminRoutes');
const { GameService } = require('../../services/game/src/service/gameService');
const { GameRepository } = require('../../services/game/src/repository/gameRepository');
const openApiDocument = require('../../services/game/src/openapiDocument');
const shared = require('../../shared/src');
const config = require('../../shared/src/config');
const { startServer, silentLogger } = require('../helpers/http');
const {
  FakePgPool,
  createFakeCache,
  FakeRedisClient,
  createFakeMessaging,
  createFakeQuestionClient,
} = require('../helpers/fakes');

const QUESTIONS = [
  { id: 'r1', prompt: 'Remote: 1/4 + 1/4?', options: ['1/2', '1/8'], correctOption: '1/2', difficulty: 'easy', weight: 1 },
  { id: 'r2', prompt: 'Remote: 1/2 of 1/2?', options: ['1/4', '1'], correctOption: '1/4', difficulty: 'easy', weight: 1 },
];

async function buildServer() {
  const pool = new FakePgPool();
  const redis = new FakeRedisClient();
  const cache = createFakeCache(redis);
  const messaging = createFakeMessaging();
  const metrics = shared.observability.createMetrics('GameComponent');
  const repository = new GameRepository({ pool, cache, logger: silentLogger, schema: 'game', metrics });
  const questionClient = createFakeQuestionClient({ questions: QUESTIONS });
  // AdminComponent proxies question writes to QuestionComponent over an HTTP client.
  questionClient.call = async (path, opts) => ({ proxied: true, path, method: opts && opts.method });
  const service = new GameService({
    repository, questionClient, messaging, metrics, logger: silentLogger, config,
  });

  const app = createApp({
    componentName: 'GameComponent',
    logger: silentLogger,
    metrics,
    openApiDocument,
    readyChecks: [
      { name: 'postgres', check: () => shared.postgres.ping(pool), required: true },
      { name: 'redis', check: () => redis.isReady, required: false },
      { name: 'rabbitmq', check: () => messaging.isConnected(), required: false },
    ],
    mountRoutes: (a) => {
      a.use(createGameRoutes({ service, logger: silentLogger }));
      a.use(ADMIN_BASE_PATH, createAdminRoutes({ service, logger: silentLogger, questionClient }));
    },
  });

  const client = await startServer(app);
  return { client, pool, service, messaging };
}

/** Issue a real signed token so authenticated routes are exercised end to end. */
function token(role = 'admin') {
  const scopes = shared.oauth2.ROLE_SCOPES[role] || [];
  return shared.oauth2.signToken({
    sub: 'test-user', username: 'tester', role, roles: [role], scope: scopes.join(' '),
  });
}

describe('GameComponent: spec-verbatim GET /play', () => {
  test('returns 200 with an integer gameId exactly as the spec schema declares', async () => {
    const { client } = await buildServer();
    const res = await client.get('/play');
    await client.close();

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('gameId');
    // openapi.yaml: gameId: { type: integer, description: Game ID }
    expect(Number.isInteger(res.body.gameId)).toBe(true);
  });

  test('is unauthenticated, as the spec declares no security scheme for /play', async () => {
    const { client } = await buildServer();
    const res = await client.get('/play');
    await client.close();
    expect(res.status).not.toBe(401);
  });

  test('a second play still returns a valid integer id', async () => {
    const { client } = await buildServer();
    const first = await client.get('/play');
    const second = await client.get('/play');
    await client.close();
    expect(Number.isInteger(second.body.gameId)).toBe(true);
    expect(second.body.gameId).toBeGreaterThanOrEqual(first.body.gameId);
  });
});
describe('GameComponent: health, readiness and metrics (section E/G)', () => {
  test('GET /health reports UP', async () => {
    const { client } = await buildServer();
    const res = await client.get('/health');
    await client.close();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('UP');
    expect(res.body.component).toBe('GameComponent');
  });

  test('GET /ready is 200 when PostgreSQL is reachable, even if Redis/RabbitMQ are not', async () => {
    const { client } = await buildServer();
    const res = await client.get('/ready');
    await client.close();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('READY');
    const postgres = res.body.checks.find((c) => c.name === 'postgres');
    expect(postgres.ok).toBe(true);
  });

  test('GET /metrics exposes Prometheus text format', async () => {
    const { client } = await buildServer();
    const res = await client.get('/metrics');
    await client.close();
    expect(res.status).toBe(200);
    expect(res.text).toContain('spacefractions');
  });

  test('GET /openapi.json serves the component API document', async () => {
    const { client } = await buildServer();
    const res = await client.get('/openapi.json');
    await client.close();
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('openapi');
  });

  test('an unknown route is a 404 with a structured error body', async () => {
    const { client } = await buildServer();
    const res = await client.get('/api/v1/nope');
    await client.close();
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});

describe('GameComponent: /api/v1 games (FR-1, SequenceDiagram1)', () => {
  test('POST /api/v1/games starts a game and returns the initial prompt', async () => {
    const { client } = await buildServer();
    const res = await client.post('/api/v1/games', { body: { questionCount: 2 } });
    await client.close();

    expect(res.status).toBe(201);
    expect(res.body.state).toBe('Playing');
    expect(res.body.totalQuestions).toBe(2);
    expect(res.body.question).toBeDefined();
    // The answer key must never reach the student.
    expect(res.body.question).not.toHaveProperty('correctOption');
  });

  test('POST /api/v1/games accepts an authenticated caller and still succeeds', async () => {
    const { client } = await buildServer();
    const res = await client.post('/api/v1/games', {
      body: { questionCount: 2 },
      headers: { authorization: `Bearer ${token('student')}` },
    });
    await client.close();
    expect(res.status).toBe(201);
  });

  test('GET /api/v1/games/{id} returns the current prompt', async () => {
    const { client } = await buildServer();
    const created = await client.post('/api/v1/games', { body: { questionCount: 2 } });
    const res = await client.get(`/api/v1/games/${created.body.gameId}`);
    await client.close();

    expect(res.status).toBe(200);
    expect(res.body.progress).toEqual({ answered: 0, total: 2 });
    expect(res.body.question.id).toBe('r1');
  });

  test('GET /api/v1/games/{unknown} is a 404', async () => {
    const { client } = await buildServer();
    const res = await client.get('/api/v1/games/00000000-0000-0000-0000-000000000000');
    await client.close();
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('game_not_found');
  });

  test('POST answers grades and advances to the next prompt', async () => {
    const { client } = await buildServer();
    const created = await client.post('/api/v1/games', { body: { questionCount: 2 } });
    const res = await client.post(`/api/v1/games/${created.body.gameId}/answers`, {
      body: { questionId: 'r1', answer: '1/2' },
    });
    await client.close();

    expect(res.status).toBe(200);
    expect(res.body.correct).toBe(true);
    expect(res.body.score).toBe(10);
    expect(res.body.question.id).toBe('r2');
  });

  test('POST answers without questionId/answer is a 400', async () => {
    const { client } = await buildServer();
    const created = await client.post('/api/v1/games', { body: { questionCount: 2 } });
    const res = await client.post(`/api/v1/games/${created.body.gameId}/answers`, { body: {} });
    await client.close();

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  test('the full round ends with feedback and GameOver (ending scene)', async () => {
    const { client } = await buildServer();
    const created = await client.post('/api/v1/games', { body: { questionCount: 2 } });
    const id = created.body.gameId;
    await client.post(`/api/v1/games/${id}/answers`, { body: { questionId: 'r1', answer: '1/2' } });
    const last = await client.post(`/api/v1/games/${id}/answers`, { body: { questionId: 'r2', answer: '1/4' } });
    await client.close();

    expect(last.body.state).toBe('GameOver');
    expect(last.body.feedback.completed).toBe(true);
    expect(last.body.feedback.accuracy).toBe(1);
  });

  test('GET score reflects answers given (View Score use case)', async () => {
    const { client } = await buildServer();
    const created = await client.post('/api/v1/games', { body: { questionCount: 2 } });
    const id = created.body.gameId;
    await client.post(`/api/v1/games/${id}/answers`, { body: { questionId: 'r1', answer: '1/2' } });
    const res = await client.get(`/api/v1/games/${id}/score`);
    await client.close();

    expect(res.status).toBe(200);
    expect(res.body.score).toBe(10);
  });

  test('pause and resume follow the StateDiagram', async () => {
    const { client } = await buildServer();
    const created = await client.post('/api/v1/games', { body: { questionCount: 2 } });
    const id = created.body.gameId;

    const paused = await client.post(`/api/v1/games/${id}/pause`);
    const resumed = await client.post(`/api/v1/games/${id}/resume`);
    await client.close();

    expect(paused.body.state).toBe('Paused');
    expect(resumed.body.state).toBe('Playing');
  });

  test('gameover ends the round and returns feedback', async () => {
    const { client } = await buildServer();
    const created = await client.post('/api/v1/games', { body: { questionCount: 2 } });
    const res = await client.post(`/api/v1/games/${created.body.gameId}/gameover`);
    await client.close();

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('GameOver');
    expect(res.body.feedback).toBeDefined();
  });

  test('GET /api/v1/leaderboard returns ordered entries', async () => {
    const { client } = await buildServer();
    const created = await client.post('/api/v1/games', { body: { questionCount: 2 } });
    await client.post(`/api/v1/games/${created.body.gameId}/answers`, { body: { questionId: 'r1', answer: '1/2' } });
    const res = await client.get('/api/v1/leaderboard?limit=5');
    await client.close();

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.limit).toBe(5);
  });

  test('GET /api/v1/help returns lesson content (View Help use case)', async () => {
    const { client } = await buildServer();
    const res = await client.get('/api/v1/help');
    await client.close();
    expect(res.status).toBe(200);
    expect(res.body.topic).toBe('Fractions');
  });
});

describe('GameComponent: admin surface (ComponentDiagram GameComponent -- AdminComponent)', () => {
  test('admin routes are mounted under the documented base path', async () => {
    expect(ADMIN_BASE_PATH).toBe('/api/v1/admin');
  });

  test('an unauthenticated admin call is rejected with 401', async () => {
    const { client } = await buildServer();
    const res = await client.get(`${ADMIN_BASE_PATH}/games/stats`);
    await client.close();
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  test('a non-admin (student) token is rejected with 403', async () => {
    const { client } = await buildServer();
    const res = await client.get(`${ADMIN_BASE_PATH}/games/stats`, {
      headers: { authorization: `Bearer ${token('student')}` },
    });
    await client.close();
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('insufficient_scope');
  });

  test('an admin token can read game stats (section G completion rate)', async () => {
    const { client } = await buildServer();
    const created = await client.post('/api/v1/games', { body: { questionCount: 2 } });
    await client.post(`/api/v1/games/${created.body.gameId}/gameover`);

    const res = await client.get(`${ADMIN_BASE_PATH}/games/stats`, {
      headers: { authorization: `Bearer ${token('admin')}` },
    });
    await client.close();

    expect(res.status).toBe(200);
    expect(res.body.gamesTotal).toBeGreaterThanOrEqual(1);
    expect(res.body.gamesCompleted).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.completionRate).toBe('number');
    expect(res.body.completionRate).toBeGreaterThan(0);
  });

  test('an admin token can proxy a question update (UseCaseDiagram Update Questions)', async () => {
    const { client } = await buildServer();
    const res = await client.post(`${ADMIN_BASE_PATH}/questions`, {
      body: { prompt: 'New?', options: ['a', 'b'], correctOption: 'a' },
      headers: { authorization: `Bearer ${token('admin')}` },
    });
    await client.close();

    expect(res.status).toBe(201);
    expect(res.body.proxied).toBe(true);
    expect(res.body.path).toBe('/api/v1/questions');
  });

  test('an invalid token is rejected with 401 invalid_token', async () => {
    const { client } = await buildServer();
    const res = await client.get(`${ADMIN_BASE_PATH}/games/stats`, {
      headers: { authorization: 'Bearer not.a.real.token' },
    });
    await client.close();
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });
});
