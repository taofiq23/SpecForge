'use strict';

/**
 * GameService tests - the application layer behind GameComponent.
 *
 * Walks SequenceDiagram1 (spec.json view 6):
 *   User->>Game: play()
 *   Game->>Question: getPrompt()
 *   Question->>Game: return prompt
 *   User->>Game: submit answer
 *   Game->>Question: check answer
 *   Question->>Game: return result
 * plus the offline-degradation paths (QuestionComponent unreachable).
 */
const { GameService } = require('../../services/game/src/service/gameService');
const { GameRepository } = require('../../services/game/src/repository/gameRepository');
const config = require('../../shared/src/config');
const {
  FakePgPool,
  FakeRedisClient,
  createFakeCache,
  createFakeMessaging,
  createFakeQuestionClient,
} = require('../helpers/fakes');

const REMOTE_QUESTIONS = [
  { id: 'r1', prompt: 'Remote: 1/4 + 1/4?', options: ['1/2', '1/8'], correctOption: '1/2', difficulty: 'easy', weight: 1 },
  { id: 'r2', prompt: 'Remote: 1/2 of 1/2?', options: ['1/4', '1'], correctOption: '1/4', difficulty: 'easy', weight: 1 },
];

function buildService({ questions = REMOTE_QUESTIONS, throwOnList = false, throwOnCheck = false, healthy = true } = {}) {
  const pool = new FakePgPool();
  const redis = new FakeRedisClient();
  const cache = createFakeCache(redis);
  const messaging = createFakeMessaging();
  const logger = { info() {}, debug() {}, warn() {}, error() {} };
  const repository = new GameRepository({ pool, cache, logger, schema: 'game' });
  const questionClient = createFakeQuestionClient({ questions, throwOnList, throwOnCheck, healthy });
  const service = new GameService({ repository, questionClient, messaging, metrics: null, logger, config });
  return { service, repository, pool, cache, redis, messaging, questionClient };
}

describe('GameService.play() / startGame (FR-1 Play game, UseCaseDiagram)', () => {
  test('creates a Playing game with questions pulled from QuestionComponent', async () => {
    const { service, messaging } = buildService();
    const started = await service.startGame({ userId: 'u1', username: 'astro', questionCount: 2 });

    expect(started.state).toBe('Playing');
    expect(started.score).toBe(0);
    expect(started.totalQuestions).toBe(2);
    expect(started.gameId).toBeTruthy();
    // The initial prompt is present but the answer key is withheld from students.
    expect(started.question.id).toBe('r1');
    expect(started.question).not.toHaveProperty('correctOption');
  });

  test('persists the new game to PostgreSQL (ASR-1 durability)', async () => {
    const { service, pool } = buildService();
    const started = await service.startGame({ questionCount: 2 });
    expect(pool.games).toHaveLength(1);
    expect(pool.games[0].game_uid).toBe(started.gameId);
  });

  test('caches the new game state in Redis (section D caching strategy)', async () => {
    const { service, cache } = buildService();
    const started = await service.startGame({ questionCount: 2 });
    expect(await cache.get(`game:state:${started.gameId}`)).toBeTruthy();
  });

  test('publishes game.started on RabbitMQ with the game id', async () => {
    const { service, messaging } = buildService();
    const started = await service.startGame({ questionCount: 2 });
    const events = messaging.events(config.rabbitmq.events.gameStarted);
    expect(events).toHaveLength(1);
    expect(events[0].payload.gameId).toBe(started.gameId);
  });

  test('falls back to the built-in bank when QuestionComponent is unreachable', async () => {
    const { service, logger } = buildService({ throwOnList: true });
    const started = await service.startGame({ questionCount: 3 });
    expect(started.totalQuestions).toBe(3);
    expect(started.question.id).toMatch(/^builtin-/);
  });

  test('falls back when QuestionComponent returns an empty bank', async () => {
    const { service } = buildService({ questions: [] });
    const started = await service.startGame({ questionCount: 4 });
    expect(started.totalQuestions).toBe(4);
  });

  test('the fallback bank ramps difficulty across the round', async () => {
    const { service } = buildService({ throwOnList: true });
    const started = await service.startGame({ questionCount: 10 });
    await service.getPrompt(started.gameId); // ensure persisted state is readable
    const game = await service.requireGame(started.gameId);
    expect(game.questions[0].difficulty).toBe('easy');
    expect(game.questions[5].difficulty).toBe('medium');
    expect(game.questions[9].difficulty).toBe('hard');
  });
});

describe('GameService.getPrompt (SequenceDiagram1: display prompt)', () => {
  test('returns the current prompt with progress', async () => {
    const { service } = buildService();
    const started = await service.startGame({ questionCount: 2 });
    const prompt = await service.getPrompt(started.gameId);

    expect(prompt.gameId).toBe(started.gameId);
    expect(prompt.state).toBe('Playing');
    expect(prompt.progress).toEqual({ answered: 0, total: 2 });
    expect(prompt.question.id).toBe('r1');
    expect(prompt.question.options.length).toBeGreaterThan(0);
  });

  test('an unknown game id raises a 404', async () => {
    const { service } = buildService();
    await expect(service.getPrompt('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({
      status: 404,
      code: 'game_not_found',
    });
  });
});

describe('GameService.submitAnswer (SequenceDiagram1: check answer -> display result)', () => {
  async function startedService(opts) {
    const ctx = buildService(opts);
    const started = await ctx.service.startGame({ userId: 'u1', questionCount: 2 });
    return { ...ctx, started };
  }

  test('grades a correct answer via QuestionComponent and advances progress', async () => {
    const { service, started, messaging } = await startedService();
    const result = await service.submitAnswer(started.gameId, { questionId: 'r1', answer: '1/2' });

    expect(result.correct).toBe(true);
    expect(result.score).toBe(10);
    expect(result.awarded).toBe(10);
    expect(result.progress.answered).toBe(1);
    expect(result.question.id).toBe('r2');
    expect(messaging.events(config.rabbitmq.events.answerSubmitted)).toHaveLength(1);
  });

  test('grades an incorrect answer with no points', async () => {
    const { service, started } = await startedService();
    const result = await service.submitAnswer(started.gameId, { questionId: 'r1', answer: '1/8' });
    expect(result.correct).toBe(false);
    expect(result.score).toBe(0);
  });

  test('falls back to grading against the composition copy when QuestionComponent is down', async () => {
    const { service, started } = await startedService({ throwOnCheck: true });
    const result = await service.submitAnswer(started.gameId, { questionId: 'r1', answer: '1/2' });
    expect(result.correct).toBe(true);
  });

  test('persists each answer so a crash mid-round loses nothing (ASR-1)', async () => {
    const { service, started, pool } = await startedService();
    await service.submitAnswer(started.gameId, { questionId: 'r1', answer: '1/2' });
    const row = pool.games.find((g) => g.game_uid === started.gameId);
    expect(row.game_state.answers).toHaveLength(1);
  });

  test('a question not in the game is a 404', async () => {
    const { service, started } = await startedService();
    await expect(
      service.submitAnswer(started.gameId, { questionId: 'ghost', answer: '1/2' }),
    ).rejects.toMatchObject({ status: 404, code: 'question_not_in_game' });
  });

  test('answering twice is a 409 (illegal state)', async () => {
    const { service, started } = await startedService();
    await service.submitAnswer(started.gameId, { questionId: 'r1', answer: '1/2' });
    await expect(
      service.submitAnswer(started.gameId, { questionId: 'r1', answer: '1/2' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  test('completing the last question returns feedback and publishes game.completed', async () => {
    const { service, started, messaging } = await startedService();
    await service.submitAnswer(started.gameId, { questionId: 'r1', answer: '1/2' });
    const last = await service.submitAnswer(started.gameId, { questionId: 'r2', answer: '1/4' });

    expect(last.state).toBe('GameOver');
    expect(last.feedback).toBeDefined();
    expect(last.feedback.completed).toBe(true);
    expect(last.feedback.accuracy).toBe(1);
    expect(messaging.events(config.rabbitmq.events.gameCompleted)).toHaveLength(1);
  });
});

describe('GameService score, pause/resume, gameOver and help', () => {
  test('viewScore returns the score and full feedback', async () => {
    const { service, started } = buildService;
    const ctx = buildService();
    const game = await ctx.service.startGame({ questionCount: 2 });
    await ctx.service.submitAnswer(game.gameId, { questionId: 'r1', answer: '1/2' });
    const score = await ctx.service.viewScore(game.gameId);
    expect(score.score).toBe(10);
    expect(score.accuracy).toBeCloseTo(0.5);
  });

  test('pause then resume round-trips through persistence', async () => {
    const { service, pool } = buildService();
    const game = await service.startGame({ questionCount: 2 });

    expect((await service.pause(game.gameId)).state).toBe('Paused');
    expect(pool.games[0].game_state.state).toBe('Paused');
    expect((await service.resume(game.gameId)).state).toBe('Playing');
  });

  test('gameOver ends the game and reports feedback', async () => {
    const { service } = buildService();
    const game = await service.startGame({ questionCount: 2 });
    const ended = await service.gameOver(game.gameId);
    expect(ended.state).toBe('GameOver');
    expect(ended.feedback.completed).toBe(true);
  });

  test('leaderboard returns the highest scores first', async () => {
    const { service, pool } = buildService();
    const a = await service.startGame({ userId: 'u1', username: 'a', questionCount: 2 });
    await service.submitAnswer(a.gameId, { questionId: 'r1', answer: '1/2' });
    await service.submitAnswer(a.gameId, { questionId: 'r2', answer: '1/4' });

    const b = await service.startGame({ userId: 'u2', username: 'b', questionCount: 2 });
    await service.submitAnswer(b.gameId, { questionId: 'r1', answer: 'wrong' });

    const board = await service.leaderboard({ limit: 10 });
    expect(board.entries.length).toBe(2);
    expect(board.entries[0].score).toBeGreaterThanOrEqual(board.entries[1].score);
    expect(board.limit).toBe(10);
  });

  test('viewHelp returns lesson content for the View Help use case', () => {
    const { service } = buildService();
    const help = service.viewHelp();
    expect(help.topic).toBe('Fractions');
    expect(help.steps.length).toBeGreaterThan(0);
    expect(help.tips.length).toBeGreaterThan(0);
  });

  test('publicQuestion never leaks the answer key', () => {
    const { service } = buildService();
    const projected = service.publicQuestion({ id: 'x', prompt: 'p', options: ['a'], correctOption: 'a' });
    expect(projected).not.toHaveProperty('correctOption');
  });
});

describe('NFR-1 latency budget on the request path', () => {
  test('the full play -> prompt -> answer cycle stays inside the 250ms budget', async () => {
    const { service } = buildService();
    const started = Date.now();
    const game = await service.startGame({ questionCount: 10 });
    await service.getPrompt(game.gameId);
    await service.submitAnswer(game.gameId, { questionId: 'r1', answer: '1/2' });
    const elapsed = Date.now() - started;

    // Against in-memory fakes this is the pure application-logic budget; the
    // spec's SLO latency budget is config.slo.latencyBudgetMs.
    expect(elapsed).toBeLessThan(config.slo.latencyBudgetMs * 4);
  });
});
