'use strict';

const { Game } = require('../domain/game');

/**
 * GameRepository - persistence for GameComponent game state.
 *
 * Data model (spec section D, verbatim):
 *   CREATE TABLE games (
 *     id SERIAL PRIMARY KEY,
 *     game_state JSONB NOT NULL
 *   );
 *
 * The spec's DDL uses `id SERIAL`, but the ClassDiagram types Game.id as
 * `string` and our Redis/HTTP layer uses UUIDs. We keep the spec's `id SERIAL`
 * column as the surrogate key and add a `game_uid` UUID column, with the same
 * JSONB `game_state` payload. This is spelled out in README -> "Underspecified
 * areas" and the DDL file carries both columns so the artifact matches the
 * spec verbatim while the code stays consistent with the class diagram.
 */
class GameRepository {
  constructor({ pool, cache, logger, schema = 'game', metrics = null }) {
    this.pool = pool;
    this.cache = cache;
    this.logger = logger;
    this.schema = schema;
    this.metrics = metrics;
  }

  get qualifiedTable() {
    return `${this.schema}.games`;
  }

  cacheKey(gameId) {
    return `game:state:${gameId}`;
  }

  async save(game) {
    const payload = JSON.stringify(game.toJSON());
    const query = `
      INSERT INTO ${this.qualifiedTable} (game_uid, game_state)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (game_uid) DO UPDATE
        SET game_state = EXCLUDED.game_state,
            updated_at = NOW()
      RETURNING id, game_uid, updated_at
    `;
    const op = async () => {
      const { rows } = await this.pool.query(query, [game.id, payload]);
      return rows[0];
    };
    const row = this.metrics ? await this.metrics.timeExternal('postgres', 'saveGame', op) : await op();

    // Section D caching strategy: "Cache game state in Redis".
    if (this.cache) await this.cache.set(this.cacheKey(game.id), game.toJSON());
    return row;
  }

  /**
   * Read-through: Redis first, PostgreSQL as the authority (ASR-1). Any cache
   * miss rehydrates from PostgreSQL so durability never depends on Redis.
   */
  async findById(gameId) {
    if (this.cache) {
      const cached = await this.cache.get(this.cacheKey(gameId));
      if (cached) {
        this.logger && this.logger.debug({ gameId }, 'game state served from redis');
        return Game.fromJSON(cached);
      }
    }

    const op = async () => {
      const { rows } = await this.pool.query(
        `SELECT game_state FROM ${this.qualifiedTable} WHERE game_uid = $1`,
        [gameId],
      );
      return rows[0] ? rows[0].game_state : null;
    };
    const state = this.metrics ? await this.metrics.timeExternal('postgres', 'loadGame', op) : await op();
    if (!state) return null;

    const game = Game.fromJSON(state);
    if (this.cache) await this.cache.set(this.cacheKey(game.id), game.toJSON());
    return game;
  }

  async invalidate(gameId) {
    if (this.cache) await this.cache.del(this.cacheKey(gameId));
  }

  /** For the "game completion rate" metric in section G. */
  async countByState(state) {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM ${this.qualifiedTable} WHERE game_state->>'state' = $1`,
      [state],
    );
    return rows[0].count;
  }

  async countAll() {
    const { rows } = await this.pool.query(`SELECT COUNT(*)::int AS count FROM ${this.qualifiedTable}`);
    return rows[0].count;
  }

  /** Leaderboard / ViewScore support: highest scores for a user. */
  async topScores(userId, limit = 10) {
    const { rows } = await this.pool.query(
      `SELECT game_uid,
              (game_state->>'score')::int AS score,
              game_state->>'state' AS state,
              game_state->'user'->>'username' AS username,
              updated_at
         FROM ${this.qualifiedTable}
        WHERE ($1::text IS NULL OR game_state->'user'->>'id' = $1)
        ORDER BY (game_state->>'score')::int DESC
        LIMIT $2`,
      [userId || null, limit],
    );
    return rows;
  }
}

module.exports = { GameRepository };
