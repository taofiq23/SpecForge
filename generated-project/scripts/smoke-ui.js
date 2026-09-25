'use strict';

/**
 * End-to-end smoke test: boots the real GameComponent (with the test fakes
 * substituted for PostgreSQL/Redis/RabbitMQ/QuestionComponent), then walks the
 * exact HTTP calls the browser UI makes - including fetching the static page
 * from the game origin.
 *
 *   node scripts/smoke-ui.js
 *
 * This is what proves "npm start shows a working game in a browser" without
 * needing Docker: the same code paths, over a real TCP listener.
 */
const http = require('http');
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

  const server = await new Promise((resolve) => {
    const s = component.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const results = [];
  const call = async (method, path, body, headers) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(headers || {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* html */ }
    return { status: res.status, text, json, type: res.headers.get('content-type') };
  };

  // 1. intro + menu: the static page and its assets load from the game origin.
  const page = await call('GET', '/');
  results.push(['GET  /                 (intro/menu HTML)', page.status, page.text.includes('scene-intro')]);
  const css = await call('GET', '/styles.css');
  results.push(['GET  /styles.css       (theme)', css.status, css.type.includes('css')]);
  const cfg = await call('GET', '/ui-config.js');
  results.push(['GET  /ui-config.js     (runtime config)', cfg.status, cfg.text.includes('SPACE_FRACTIONS_CONFIG')]);
  const adminPage = await call('GET', '/admin');
  results.push(['GET  /admin            (AdminClient HTML)', adminPage.status, adminPage.text.includes('admin-component') || adminPage.text.includes('AdminComponent')]);

  // 2. the spec-verbatim /play endpoint the UI uses for a default round.
  const play = await call('GET', '/play');
  results.push(['GET  /play             (spec endpoint)', play.status, Number.isInteger(play.json.gameId) && !!play.json.gameUid]);

  // 3. question screens: prompt -> answers -> score.
  const prompt = await call('GET', `/api/v1/games/${play.json.gameUid}`);
  results.push(['GET  /api/v1/games/{id} (display prompt)', prompt.status, !!prompt.json.question]);

  const a1 = await call('POST', `/api/v1/games/${prompt.json.gameId}/answers`, { questionId: prompt.json.question.id, answer: '3/4', timeMs: 1500 });
  results.push(['POST .../answers       (submit + grade)', a1.status, a1.json.correct === true]);

  const a2 = await call('POST', `/api/v1/games/${prompt.json.gameId}/answers`, { questionId: a1.json.question ? a1.json.question.id : 'seed-2', answer: 'wrong', timeMs: 800 });
  results.push(['POST .../answers       (wrong answer, no penalty)', a2.status, a2.json.correct === false && a2.json.awarded === 0]);

  const score = await call('GET', `/api/v1/games/${prompt.json.gameId}/score`);
  results.push(['GET  .../score         (ending scene, real score)', score.status, typeof score.json.score === 'number']);

  // 4. StateDiagram transitions the pause/resume buttons drive.
  const newGame = await call('POST', '/api/v1/games', { questionCount: 3 });
  const pause = await call('POST', `/api/v1/games/${newGame.json.gameId}/pause`);
  const resume = await call('POST', `/api/v1/games/${newGame.json.gameId}/resume`);
  results.push(['POST .../pause|resume  (StateDiagram)', resume.status, pause.json.state === 'Paused' && resume.json.state === 'Playing']);

  // 5. menu extras.
  const help = await call('GET', '/api/v1/help');
  results.push(['GET  /api/v1/help      (View Help)', help.status, help.json.topic === 'Fractions']);
  const board = await call('GET', '/api/v1/leaderboard?limit=5');
  results.push(['GET  /api/v1/leaderboard (View Score)', board.status, Array.isArray(board.json.entries)]);

  // 6. AdminClient: token -> updateQuestions on the real AdminComponent.
  const scopes = shared.oauth2.ROLE_SCOPES.admin.join(' ');
  const token = shared.oauth2.signToken({ sub: 'smoke-admin', username: 'smoke', role: 'admin', roles: ['admin'], scope: scopes });
  const who = await call('GET', '/api/v1/admin/whoami', null, { authorization: `Bearer ${token}` });
  results.push(['GET  /api/v1/admin/whoami (AdminClient sign-in)', who.status, who.json.roles && who.json.roles.includes('admin')]);
  const create = await call('POST', '/api/v1/admin/questions', { prompt: 'Smoke test question?', options: ['a', 'b'], correctOption: 'a' }, { authorization: `Bearer ${token}` });
  results.push(['POST /api/v1/admin/questions (updateQuestions)', create.status, create.status === 201]);
  const unauth = await call('GET', '/api/v1/admin/games/stats');
  results.push(['GET  /api/v1/admin/games/stats (no token -> 401)', unauth.status, unauth.status === 401]);

  await new Promise((r) => server.close(r));

  let failed = 0;
  console.log('\nSpace Fractions UI smoke test (real HTTP, no Docker needed)\n');
  for (const [label, status, ok] of results) {
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(status).padEnd(4)} ${label}`);
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(2);
});
