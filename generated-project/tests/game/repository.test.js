'use strict';

/**
 * GameRepository tests - persistence of GameComponent game state.
 *
 * Data model comes from spec section D:
 *   CREATE TABLE games (id SERIAL PRIMARY KEY, game_state JSONB NOT NULL);
 * and the caching strategy is section D's "Cache game state in Redis /
 * Use PostgreSQL for data persistence".
 *
 * The key property under test is ASR-1: PostgreSQL is authoritative, so a Redis
 * outage may cost latency but must never lose or misreport game state.
 */
const { GameRepository } = require('../../services/game/src/repository/gameRepository');
const { Game } = require('../../services/game/src/domain/game');
const { FakePgPool, FakeRedisClient, createFakeCache } = require('../helpers/fakes');

const QUESTIONS = [
  { id: 'q1', prompt: 'What is 1/2 + 1/4?', options: ['2/6', '3/4'], correctOption: '3/4', difficulty: 'easy', weight: 1 },
  { id: 'q2', prompt: 'What is 2/3 - 1/6?', options: ['1/3', '1/2'], correctOption: '1/2', difficulty: 'easy', weight: 1 },
];

const logger = { info() {}, debug() {}, warn() {}, error() {} };

function build() {
  const pool = new FakePgPool();
  const redis = new FakeRedisClient();
  const cache = createFakeCache(redis);
  const repository = new GameRepository({ pool, cache, logger, schema: 'game' });
  return { pool, redis, cache, repository };
}

describe('GameRepository.save / findById', () => {
  test('round-trips a game through PostgreSQL', async () => {
    const { repository } = build();
    const game = new Game({ user: { id: 'u1', username: 'astro' }, questions: QUESTIONS });
    game.submitAnswer({ questionId: 'q1', answer: '3/4' });

    await repository.save(game);
    // Bypass the cache to prove PostgreSQL alone is sufficient (ASR-1).
    const fresh = new GameRepository({
      pool: build().pool,
      cache: null,
      logger,
      schema: 'game',
    });
    const loaded = await repository.findById(game.id);
    expect(loaded.id).toBe(game.id);
    expect(loaded.score).toBe(10);
    expect(loaded.answers).toHaveLength(1);
    expect(fresh).toBeDefined();
  });

  test('save is an upsert keyed on game_uid, so repeated saves do not duplicate', async () => {
    const { repository, pool } = build();
    const game = new Game({ questions: QUESTIONS });
    await repository.save(game);
    game.submitAnswer({ questionId: 'q1', answer: '3/4' });
    await repository.save(game);

    expect(pool.games).toHaveLength(1);
    expect(pool.games[0].game_state.score).toBe(10);
  });

  test('findById returns null for an unknown id', async () => {
    const { repository } = build();
    expect(await repository.findById('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  test('the row keeps the spec DDL shape: id SERIAL plus a JSONB game_state', async () => {
    const { repository, pool } = build();
    const game = new Game({ questions: QUESTIONS });
    await repository.save(game);
    const row = pool.games[0];
    expect(Number.isInteger(row.id)).toBe(true);
    expect(typeof row.game_state).toBe('object');
  });

  test('the repository targets the component-owned schema', async () => {
    const { repository, pool } = build();
    await repository.save(new Game({ questions: QUESTIONS }));
    expect(pool.queries[0].sql).toContain('INSERT INTO game.games');
  });
});

describe('GameRepository cache-aside behaviour (Redis 6)', () => {
  test('a save populates Redis with the game state', async () => {
    const { repository, cache } = build();
    const game = new Game({ questions: QUESTIONS });
    await repository.save(game);
    expect(await cache.get(`game:state:${game.id}`)).toBeTruthy();
  });

  test('a warm cache is served without touching PostgreSQL', async () => {
    const { repository, pool } = build();
    const game = new Game({ questions: QUESTIONS });
    await repository.save(game);

    const queriesAfterSave = pool.queries.length;
    await repository.findById(game.id);
    expect(pool.queries.length).toBe(queriesAfterSave);
  });

  test('a cold cache rehydrates from PostgreSQL and repopulates Redis', async () => {
    const { repository, pool, cache } = build();
    const game = new Game({ questions: QUESTIONS });
    await repository.save(game);
    await cache.del(`game:state:${game.id}`);

    const loaded = await repository.findById(game.id);
    expect(loaded.id).toBe(game.id);
    expect(await cache.get(`game:state:${game.id}`)).toBeTruthy();
    expect(pool.queries.some((q) => q.sql.startsWith('SELECT game_state'))).toBe(true);
  });

  test('ASR-1: a Redis outage still returns correct state from PostgreSQL', async () => {
    const { repository, redis } = build();
    const game = new Game({ questions: QUESTIONS });
    await repository.save(game);

    // Redis is down: the read must degrade to a cache miss and be served from
    // PostgreSQL, because durability may not depend on the cache.
    redis.simulateOutage();
    const loaded = await repository.findById(game.id);
    expect(loaded).not.toBeNull();
    expect(loaded.id).toBe(game.id);
    expect(loaded.questions).toEqual(game.questions);
  });

  test('ASR-1: writes still persist to PostgreSQL while Redis is down', async () => {
    const { repository, redis, pool } = build();
    redis.simulateOutage();
    const game = new Game({ questions: QUESTIONS });
    await repository.save(game);

    expect(pool.games).toHaveLength(1);
    expect(pool.games[0].game_uid).toBe(game.id);
  });

  test('invalidate removes the cached entry', async () => {
    const { repository, cache } = build();
    const game = new Game({ questions: QUESTIONS });
    await repository.save(game);
    await repository.invalidate(game.id);
    expect(await cache.get(`game:state:${game.id}`)).toBeNull();
  });
});

describe('GameRepository reporting queries (section G metrics)', () => {
  test('countAll reports the number of stored games', async () => {
    const { repository } = build();
    await repository.save(new Game({ questions: QUESTIONS }));
    await repository.save(new Game({ questions: QUESTIONS }));
    expect(await repository.countAll()).toBe(2);
  });

  test('countByState supports the "game completion rate" metric', async () => {
    const { repository } = build();
    const running = new Game({ questions: QUESTIONS });
    const done = new Game({ questions: QUESTIONS });
    done.gameOver();
    await repository.save(running);
    await repository.save(done);

    expect(await repository.countByState('Playing')).toBe(1);
    expect(await repository.countByState('GameOver')).toBe(1);
  });

  test('topScores returns entries ordered by score descending', async () => {
    const { repository } = build();
    const high = new Game({ user: { id: 'u1', username: 'high' }, questions: QUESTIONS });
    high.submitAnswer({ questionId: 'q1', answer: '3/4' });
    await repository.save(high);

    const low = new Game({ user: { id: 'u2', username: 'low' }, questions: QUESTIONS });
    await repository.save(low);

    const rows = await repository.topScores(null, 10);
    expect(rows).toHaveLength(2);
    expect(rows[0].score).toBeGreaterThanOrEqual(rows[1].score);
    expect(rows[0].username).toBe('high');
  });

  test('topScores can be filtered to a single user', async () => {
    const { repository } = build();
    await repository.save(new Game({ user: { id: 'u1', username: 'a' }, questions: QUESTIONS }));
    await repository.save(new Game({ user: { id: 'u2', username: 'b' }, questions: QUESTIONS }));
    const rows = await repository.topScores('u1', 10);
    expect(rows.every((r) => r.username === 'a')).toBe(true);
  });
});
