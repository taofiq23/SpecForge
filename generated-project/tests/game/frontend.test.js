'use strict';

/**
 * Frontend delivery tests (DeploymentDiagram: GameServer -- UserClient /
 * GameServer -- AdminClient).
 *
 * These exercise the *real* GameComponent-shaped app: the same createApp factory,
 * the same game routes, the same AdminComponent module, plus the new static UI
 * routes. Nothing about the UI is mocked - the assertions read the files that
 * are actually shipped to the browser and check they wire to the routes the
 * backend really serves.
 */
const fs = require('fs');
const path = require('path');
const { createApp } = require('../../shared/src/http/app');
const { createGameRoutes } = require('../../services/game/src/routes/gameRoutes');
const { createStaticUIRoutes } = require('../../services/game/src/routes/uiRoutes');
const { AdminComponent } = require('../../services/admin/src/component');
const { GameService } = require('../../services/game/src/service/gameService');
const { GameRepository } = require('../../services/game/src/repository/gameRepository');
const openApiDocument = require('../../services/game/src/openapiDocument');
const shared = require('../../shared/src');
const config = require('../../shared/src/config');
const { startServer, silentLogger } = require('../helpers/http');
const {
  FakePgPool,
  FakeRedisClient,
  createFakeCache,
  createFakeMessaging,
  createFakeQuestionClient,
} = require('../helpers/fakes');

const WEB_ROOT = path.resolve(__dirname, '../../web');

const QUESTIONS = [
  { id: 'ui-1', prompt: 'UI: 1/2 + 1/4?', options: ['3/4', '1/6'], correctOption: '3/4', difficulty: 'easy', weight: 1 },
  { id: 'ui-2', prompt: 'UI: 2/3 - 1/6?', options: ['1/2', '1/3'], correctOption: '1/2', difficulty: 'easy', weight: 1 },
];

async function buildServer({ withAdmin = true } = {}) {
  const pool = new FakePgPool();
  const redis = new FakeRedisClient();
  const cache = createFakeCache(redis);
  const messaging = createFakeMessaging();
  const metrics = shared.observability.createMetrics('GameComponent');
  const repository = new GameRepository({ pool, cache, logger: silentLogger, schema: 'game', metrics });
  const questionClient = createFakeQuestionClient({ questions: QUESTIONS });
  questionClient.call = async (p, opts = {}) => ({
    id: 'created-1',
    proxied: true,
    path: p,
    method: opts.method,
  });
  const service = new GameService({ repository, questionClient, messaging, metrics, logger: silentLogger, config });

  const adminComponent = withAdmin
    ? new AdminComponent({ logger: silentLogger, metrics, questionClient, gameService: service })
    : null;

  const app = createApp({
    componentName: 'GameComponent',
    logger: silentLogger,
    metrics,
    openApiDocument,
    readyChecks: [{ name: 'postgres', check: () => shared.postgres.ping(pool), required: true }],
    mountRoutes: (a) => {
      a.use(createGameRoutes({ service, logger: silentLogger }));
      if (adminComponent) adminComponent.mountOn(a);
      a.use(createStaticUIRoutes({ logger: silentLogger }));
    },
  });

  const client = await startServer(app);
  return { client, service, messaging, adminComponent };
}

function token(role = 'admin') {
  const scopes = shared.oauth2.ROLE_SCOPES[role] || [];
  return shared.oauth2.signToken({
    sub: 'test-admin', username: 'admin', role, roles: [role], scope: scopes.join(' '),
  });
}

describe('Frontend: static assets are served by GameComponent', () => {
  test('GET / serves the intro/menu/question/ending single page', async () => {
    const { client } = await buildServer();
    const res = await client.get('/');
    await client.close();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    // The four scenes the executive summary names.
    expect(res.text).toContain('id="scene-intro"');
    expect(res.text).toContain('id="scene-menu"');
    expect(res.text).toContain('id="scene-question"');
    expect(res.text).toContain('id="scene-ending"');
  });

  test('GET /styles.css and /app.js are served', async () => {
    const { client } = await buildServer();
    const css = await client.get('/styles.css');
    const js = await client.get('/app.js');
    await client.close();

    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toMatch(/text\/css/);
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
  });

  test('GET /ui-config.js exposes runtime API config', async () => {
    const { client } = await buildServer();
    const res = await client.get('/ui-config.js');
    await client.close();

    expect(res.status).toBe(200);
    expect(res.text).toContain('SPACE_FRACTIONS_CONFIG');
    expect(res.text).toContain('apiBase');
  });

  test('GET /admin (and /admin.html) serves the AdminClient screen', async () => {
    const { client } = await buildServer();
    const pretty = await client.get('/admin');
    const direct = await client.get('/admin.html');
    await client.close();

    expect(pretty.status).toBe(200);
    expect(pretty.text).toContain('admin-login');
    expect(pretty.text).toContain('Update Questions');
    expect(direct.status).toBe(200);
    expect(direct.text).toContain('AdminComponent');
  });

  test('GET /admin.js is served for the admin screen', async () => {
    const { client } = await buildServer();
    const res = await client.get('/admin.js');
    await client.close();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
  });

  test('an unknown web asset is a JSON 404, not an HTML error page', async () => {
    const { client } = await buildServer();
    const res = await client.get('/nope.css');
    await client.close();
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  test('static routing does not shadow the API: /api/v1/help still resolves', async () => {
    const { client } = await buildServer();
    const res = await client.get('/api/v1/help');
    await client.close();
    expect(res.status).toBe(200);
    expect(res.body.topic).toBe('Fractions');
  });
});

describe('Frontend <-> backend contract: the UI calls routes that exist', () => {
  const appJs = fs.readFileSync(path.join(WEB_ROOT, 'app.js'), 'utf8');
  const adminJs = fs.readFileSync(path.join(WEB_ROOT, 'admin.js'), 'utf8');

  test.each([
    '/play',
    '/api/v1/games',
    '/api/v1/games/${state.gameId}',
    '/api/v1/games/${state.gameId}/answers',
    '/api/v1/games/${state.gameId}/pause',
    '/api/v1/games/${state.gameId}/resume',
    '/api/v1/games/${state.gameId}/gameover',
    '/api/v1/games/${state.gameId}/score',
    '/api/v1/leaderboard?limit=10',
    '/api/v1/help',
  ])('app.js calls %s', (route) => {
    expect(appJs).toContain(route);
  });

  test.each([
    '/oauth/token',
    '/api/v1/admin/whoami',
    '/api/v1/admin/questions',
    '/api/v1/admin/games/stats',
  ])('admin.js calls %s', (route) => {
    expect(adminJs).toContain(route);
  });

  test('the game UI does not invent a correct answer client-side', () => {
    // Grading must come from the server response, never a local answer key.
    expect(appJs).not.toMatch(/correctOption\s*[:=]\s*['"]/);
    expect(appJs).toContain('result.correct');
  });
});

describe('Frontend flows really work against the live backend', () => {
  test('the /play contract the UI depends on returns a real game uuid', async () => {
    const { client } = await buildServer();
    const play = await client.get('/play');
    const prompt = await client.get(`/api/v1/games/${play.body.gameUid}`);
    await client.close();

    expect(play.status).toBe(200);
    expect(Number.isInteger(play.body.gameId)).toBe(true);
    expect(typeof play.body.gameUid).toBe('string');
    // This is the exact follow-up call web/app.js makes.
    expect(prompt.status).toBe(200);
    expect(prompt.body.question).toBeDefined();
  });

  test('the full UI round-trip: start -> answer -> score produces a real ending', async () => {
    const { client } = await buildServer();

    const created = await client.post('/api/v1/games', {
      body: { questionCount: 2, difficulty: null, username: 'Cadet' },
    });
    const id = created.body.gameId;

    const first = await client.post(`/api/v1/games/${id}/answers`, {
      body: { questionId: 'ui-1', answer: '3/4', timeMs: 1200 },
    });
    const last = await client.post(`/api/v1/games/${id}/answers`, {
      body: { questionId: 'ui-2', answer: 'wrong', timeMs: 900 },
    });
    const score = await client.get(`/api/v1/games/${id}/score`);
    const board = await client.get('/api/v1/leaderboard?limit=10');
    await client.close();

    expect(first.body.correct).toBe(true);
    expect(first.body.awarded).toBe(10);
    expect(last.body.state).toBe('GameOver');
    // The ending scene reads exactly these fields.
    expect(score.body.score).toBe(10);
    expect(score.body.accuracy).toBeCloseTo(0.5);
    expect(score.body.totalQuestions).toBe(2);
    expect(score.body.correctAnswers).toBe(1);
    expect(Array.isArray(board.body.entries)).toBe(true);
  });

  test('the UI pause/resume buttons hit working StateDiagram transitions', async () => {
    const { client } = await buildServer();
    const created = await client.post('/api/v1/games', { body: { questionCount: 2 } });
    const id = created.body.gameId;
    const paused = await client.post(`/api/v1/games/${id}/pause`);
    const resumed = await client.post(`/api/v1/games/${id}/resume`);
    await client.close();
    expect(paused.body.state).toBe('Paused');
    expect(resumed.body.state).toBe('Playing');
  });
});

describe('Frontend: same-origin OAuth2 token proxy for AdminClient', () => {
  test('POST /oauth/token on the game origin proxies to UserComponent', async () => {
    // Stand in for UserComponent with a tiny HTTP server.
    const http = require('http');
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'proxied-token', token_type: 'Bearer', expires_in: 3600 }));
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = upstream.address().port;

    const pool = new FakePgPool();
    const app = createApp({
      componentName: 'GameComponent',
      logger: silentLogger,
      metrics: null,
      mountRoutes: (a) => {
        a.use(createStaticUIRoutes({
          logger: silentLogger,
          userBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        }));
      },
      readyChecks: [],
    });
    const client = await startServer(app);
    const res = await client.post('/oauth/token', {
      form: { grant_type: 'password', username: 'admin', password: 'secret' },
    });
    await client.close();
    await new Promise((r) => upstream.close(r));

    expect(res.status).toBe(200);
    expect(res.body.access_token).toBe('proxied-token');
    expect(pool).toBeDefined();
  });

  test('the proxy degrades with an OAuth-style error when UserComponent is down', async () => {
    const app = createApp({
      componentName: 'GameComponent',
      logger: silentLogger,
      metrics: null,
      mountRoutes: (a) => {
        a.use(createStaticUIRoutes({
          logger: silentLogger,
          userBaseUrl: 'http://127.0.0.1:1', // nothing listening
        }));
      },
      readyChecks: [],
    });
    const client = await startServer(app);
    const res = await client.post('/oauth/token', { form: { grant_type: 'password' } });
    await client.close();

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('temporarily_unavailable');
  });
});

describe('AdminComponent: a real module, not prose', () => {
  test('AdminComponent is a class with the ComponentDiagram name and a mountOn edge', () => {
    expect(typeof AdminComponent).toBe('function');
    const instance = new AdminComponent({ logger: silentLogger });
    expect(instance.name).toBe('AdminComponent');
    expect(typeof instance.mountOn).toBe('function');
    expect(instance.basePath).toBe('/api/v1/admin');
  });

  test('GameComponent mounts AdminComponent under /api/v1/admin', async () => {
    const { client, adminComponent } = await buildServer();
    expect(adminComponent.basePath).toBe('/api/v1/admin');
    const res = await client.get('/api/v1/admin/games/stats', {
      headers: { authorization: `Bearer ${token('admin')}` },
    });
    await client.close();
    expect(res.status).toBe(200);
    expect(typeof res.body.completionRate).toBe('number');
  });

  test('GET /api/v1/admin/whoami proves the token carries the admin role', async () => {
    const { client } = await buildServer();
    const res = await client.get('/api/v1/admin/whoami', {
      headers: { authorization: `Bearer ${token('admin')}` },
    });
    await client.close();

    expect(res.status).toBe(200);
    expect(res.body.component).toBe('AdminComponent');
    expect(res.body.roles).toContain('admin');
  });

  test('Update Questions is admin-only: no token -> 401, student token -> 403', async () => {
    const { client } = await buildServer();
    const anon = await client.post('/api/v1/admin/questions', {
      body: { prompt: 'x', options: ['a', 'b'], correctOption: 'a' },
    });
    const student = await client.post('/api/v1/admin/questions', {
      body: { prompt: 'x', options: ['a', 'b'], correctOption: 'a' },
      headers: { authorization: `Bearer ${token('student')}` },
    });
    await client.close();

    expect(anon.status).toBe(401);
    expect(student.status).toBe(403);
  });

  test('an admin token can create, read and deactivate a question (SequenceDiagram2)', async () => {
    const { client } = await buildServer();
    const auth = { authorization: `Bearer ${token('admin')}` };

    const created = await client.post('/api/v1/admin/questions', {
      body: { prompt: 'New fraction?', options: ['a', 'b'], correctOption: 'a' },
      headers: auth,
    });
    const list = await client.get('/api/v1/admin/questions?limit=10', { headers: auth });
    const updated = await client.put('/api/v1/admin/questions/created-1', {
      body: { prompt: 'Updated?', options: ['a', 'b'], correctOption: 'a' },
      headers: auth,
    });
    const removed = await client.del('/api/v1/admin/questions/created-1', { headers: auth });
    await client.close();

    // The proxy shape is what AdminComponent actually returns (it forwards to
    // QuestionComponent, which owns question data per section C).
    expect(created.status).toBe(201);
    expect(created.body.proxied).toBe(true);
    expect(created.body.method).toBe('POST');
    expect(list.status).toBe(200);
    expect(updated.body.method).toBe('PUT');
    expect(removed.body.method).toBe('DELETE');
  });

  test('AdminComponent can also boot standalone on its own port (DeploymentDiagram)', async () => {
    const component = new AdminComponent({ logger: silentLogger });
    const app = component.buildApp();
    const client = await startServer(app);
    const res = await client.get('/health');
    await client.close();

    expect(res.status).toBe(200);
    expect(res.body.component).toBe('AdminComponent');
  });
});
