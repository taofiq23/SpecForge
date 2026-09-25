'use strict';

/**
 * In-memory fakes for the external systems, so unit tests run with no
 * PostgreSQL / Redis / RabbitMQ / Elasticsearch running.
 *
 * These live in tests/ (not src/) deliberately: production code always talks to
 * the real clients in shared/src.
 */

/** Minimal pg Pool stand-in backed by arrays and a simple SQL matcher. */
class FakePgPool {
  constructor() {
    this.games = []; // { id, game_uid, game_state, updated_at }
    this.questions = []; // raw rows
    this.users = [];
    this.refreshTokens = [];
    this.queries = [];
    this.nextGameId = 1;
    this.nextQuestionId = 1;
    this.nextUserId = 1;
    this.failNext = null;
  }

  on() {
    return this;
  }

  async end() {
    return undefined;
  }

  async query(sql, params = []) {
    this.queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const s = String(sql).replace(/\s+/g, ' ').trim();

    // --- health / durability probes ---
    if (/^SELECT 1 AS ok/.test(s)) return { rows: [{ ok: 1 }] };
    if (/pg_stat_replication/.test(s)) return { rows: [{ standbys: 1 }] };
    if (/pg_current_wal_lsn/.test(s)) {
      return { rows: [{ wal_lsn: '0/16B3748', captured_at: new Date().toISOString() }] };
    }

    // --- game.games ---
    if (/INSERT INTO game\.games/i.test(s)) {
      const [gameUid, gameState] = params;
      const existing = this.games.find((g) => g.game_uid === gameUid);
      if (existing) {
        existing.game_state = JSON.parse(gameState);
        existing.updated_at = new Date().toISOString();
        return { rows: [{ id: existing.id, game_uid: gameUid, updated_at: existing.updated_at }] };
      }
      const row = {
        id: this.nextGameId++,
        game_uid: gameUid,
        game_state: JSON.parse(gameState),
        updated_at: new Date().toISOString(),
      };
      this.games.push(row);
      return { rows: [{ id: row.id, game_uid: row.game_uid, updated_at: row.updated_at }] };
    }
    if (/SELECT game_state FROM game\.games/i.test(s)) {
      const row = this.games.find((g) => g.game_uid === params[0]);
      return { rows: row ? [{ game_state: row.game_state }] : [] };
    }
    if (/COUNT\(\*\)::int AS count FROM game\.games WHERE/i.test(s)) {
      return { rows: [{ count: this.games.filter((g) => g.game_state.state === params[0]).length }] };
    }
    if (/COUNT\(\*\)::int AS count FROM game\.games/i.test(s)) {
      return { rows: [{ count: this.games.length }] };
    }
    if (/FROM game\.games WHERE \(\$1::text IS NULL/i.test(s)) {
      const [userId, limit] = params;
      const rows = this.games
        .filter((g) => !userId || (g.game_state.user && g.game_state.user.id === userId))
        .map((g) => ({
          game_uid: g.game_uid,
          score: g.game_state.score,
          state: g.game_state.state,
          username: g.game_state.user ? g.game_state.user.username : null,
          updated_at: g.updated_at,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      return { rows };
    }

    // --- question.questions ---
    if (/INSERT INTO question\.questions/i.test(s)) {
      const [uid, prompt, options, correctOption, difficulty, weight, tags, active] = params;
      const row = {
        id: this.nextQuestionId++,
        question_uid: uid,
        prompt,
        options: JSON.parse(options),
        correct_option: correctOption,
        difficulty,
        weight,
        tags: JSON.parse(tags),
        active,
        version: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.questions.push(row);
      return { rows: [{ id: row.id, question_uid: uid, created_at: row.created_at, updated_at: row.updated_at, version: 1 }] };
    }
    if (/INSERT INTO question\.questions[\s\S]*ON CONFLICT/i.test(s)) {
      return { rows: [] };
    }
    if (/SELECT \* FROM question\.questions WHERE question_uid = \$1 AND active = TRUE/i.test(s)) {
      const row = this.questions.find((q) => q.question_uid === params[0] && q.active);
      return { rows: row ? [row] : [] };
    }
    if (/UPDATE question\.questions[\s\S]*SET prompt = \$2/i.test(s)) {
      const row = this.questions.find((q) => q.question_uid === params[0]);
      if (!row) return { rows: [] };
      row.prompt = params[1];
      row.options = JSON.parse(params[2]);
      row.correct_option = params[3];
      row.difficulty = params[4];
      row.weight = params[5];
      row.tags = JSON.parse(params[6]);
      row.active = params[7];
      row.version += 1;
      row.updated_at = new Date().toISOString();
      return { rows: [{ id: row.id, question_uid: row.question_uid, version: row.version }] };
    }
    if (/UPDATE question\.questions SET active = FALSE/i.test(s)) {
      const row = this.questions.find((q) => q.question_uid === params[0]);
      if (!row) return { rows: [] };
      row.active = false;
      return { rows: [{ question_uid: row.question_uid }] };
    }
    if (/SELECT \* FROM question\.questions\s+WHERE \(\$1::text IS NULL/i.test(s)) {
      const [difficulty, activeOnly, limit] = params;
      let rows = this.questions.filter((q) => (activeOnly ? q.active : true));
      if (difficulty) rows = rows.filter((q) => q.difficulty === difficulty);
      return { rows: rows.slice(0, limit) };
    }
    if (/COUNT\(\*\)::int AS count FROM question\.questions/i.test(s)) {
      const activeOnly = params[0];
      return { rows: [{ count: activeOnly ? this.questions.filter((q) => q.active).length : this.questions.length }] };
    }

    // --- user_svc ---
    if (/INSERT INTO user_svc\.users/i.test(s)) {
      const [uid, username, role, hash, salt, email, displayName, active] = params;
      const row = {
        id: this.nextUserId++,
        user_uid: uid,
        username,
        role,
        password_hash: hash,
        password_salt: salt,
        email,
        display_name: displayName,
        active,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.users.push(row);
      return { rows: [{ id: row.id, user_uid: uid }] };
    }
    if (/SELECT \* FROM user_svc\.users WHERE lower\(username\)/i.test(s)) {
      const row = this.users.find((u) => u.username.toLowerCase() === String(params[0]).toLowerCase());
      return { rows: row ? [row] : [] };
    }
    if (/SELECT \* FROM user_svc\.users WHERE user_uid = \$1/i.test(s)) {
      const row = this.users.find((u) => u.user_uid === params[0]);
      return { rows: row ? [row] : [] };
    }
    if (/SELECT \* FROM user_svc\.users ORDER BY created_at/i.test(s)) {
      return { rows: this.users.slice(params[1], params[1] + params[0]) };
    }
    if (/COUNT\(\*\)::int AS count FROM user_svc\.users/i.test(s)) {
      return { rows: [{ count: this.users.length }] };
    }
    if (/UPDATE user_svc\.users SET active/i.test(s)) {
      const row = this.users.find((u) => u.user_uid === params[0]);
      if (!row) return { rows: [] };
      row.active = params[1];
      return { rows: [{ user_uid: row.user_uid }] };
    }
    if (/INSERT INTO user_svc\.refresh_tokens/i.test(s)) {
      this.refreshTokens.push({ user_uid: params[0], token_hash: params[1], expires_at: params[2], revoked: false });
      return { rows: [] };
    }
    if (/SELECT \* FROM user_svc\.refresh_tokens/i.test(s)) {
      const now = Date.now();
      const row = this.refreshTokens.find(
        (t) => t.token_hash === params[0] && !t.revoked && Date.parse(t.expires_at) > now,
      );
      return { rows: row ? [row] : [] };
    }
    if (/UPDATE user_svc\.refresh_tokens SET revoked = TRUE/i.test(s)) {
      const row = this.refreshTokens.find((t) => t.token_hash === params[0]);
      if (row) row.revoked = true;
      return { rowCount: row ? 1 : 0 };
    }
    if (/DELETE FROM user_svc\.refresh_tokens/i.test(s)) {
      const before = this.refreshTokens.length;
      this.refreshTokens = this.refreshTokens.filter(
        (t) => !t.revoked && Date.parse(t.expires_at) > Date.now(),
      );
      return { rowCount: before - this.refreshTokens.length };
    }
    if (/SELECT \* FROM user_svc\.users/i.test(s)) {
      return { rows: this.users };
    }

    throw new Error(`FakePgPool: unhandled query -> ${s}`);
  }
}

/** Redis stand-in implementing only the commands createCacheAside uses. */
class FakeRedisClient {
  constructor() {
    this.store = new Map();
    this.isReady = true;
    this.failNext = false;
  }

  on() {
    return this;
  }

  async connect() {
    this.isReady = true;
    return this;
  }

  async quit() {
    this.isReady = false;
  }

  async get(key) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('redis unavailable');
    }
    return this.store.has(key) ? this.store.get(key) : null;
  }

  async set(key, value) {
    this.store.set(key, value);
    return 'OK';
  }

  async del(key) {
    return this.store.delete(key) ? 1 : 0;
  }

  /** Test helper: force the next get() to throw, simulating an outage. */
  simulateOutage() {
    this.failNext = true;
  }

  seed(key, value) {
    this.store.set(key, JSON.stringify(value));
  }
}

/** Cache wrapper matching createCacheAside's surface. */
function createFakeCache(redis) {
  const client = redis || new FakeRedisClient();
  return {
    client,
    /**
     * Mirrors createCacheAside.get(): a Redis error is a cache miss, never a
     * request failure. This is what makes ASR-1 hold with Redis down.
     */
    async get(k) {
      try {
        const raw = await client.get(k);
        return raw ? JSON.parse(raw) : null;
      } catch (_) {
        return null;
      }
    },
    async set(k, v) {
      try {
        await client.set(k, JSON.stringify(v));
        return true;
      } catch (_) {
        return false;
      }
    },
    async del(k) {
      try {
        await client.del(k);
        return true;
      } catch (_) {
        return false;
      }
    },
    async remember(k, loader) {
      const cached = await this.get(k);
      if (cached !== null) return cached;
      const fresh = await loader();
      if (fresh !== null && fresh !== undefined) await this.set(k, fresh);
      return fresh;
    },
  };
}

/** RabbitMQ stand-in that records published events. */
function createFakeMessaging() {
  const published = [];
  return {
    published,
    async publish(routingKey, payload) {
      published.push({ routingKey, payload });
      return true;
    },
    async subscribe() {
      return true;
    },
    async close() {},
    isConnected() {
      return true;
    },
    /** Test helper: find published events by routing key. */
    events(routingKey) {
      return published.filter((p) => p.routingKey === routingKey);
    },
  };
}

/** Elasticsearch stand-in. */
function createFakeSearch() {
  const docs = new Map();
  const indexName = 'test-questions';
  return {
    indexName,
    indexed: docs,
    async ping() {
      return true;
    },
    async ensureIndex(mappings) {
      this.mappings = mappings;
      return true;
    },
    async indexDocument(id, doc) {
      docs.set(String(id), doc);
      return true;
    },
    async search(query) {
      const q = String(query).toLowerCase();
      return [...docs.values()].filter((d) => (d.prompt || '').toLowerCase().includes(q));
    },
    async delete(id) {
      return docs.delete(String(id));
    },
  };
}

/**
 * QuestionComponentClient stand-in. Either serve fixed questions, or throw to
 * exercise GameComponent's offline fallback path.
 */
function createFakeQuestionClient({ questions = null, healthy = true, throwOnList = false, throwOnCheck = false } = {}) {
  const bank = questions || [];
  return {
    async listQuestions() {
      if (throwOnList) throw new Error('question component unreachable');
      return bank;
    },
    async getPrompt(questionId) {
      const q = bank.find((x) => String(x.id) === String(questionId));
      if (!q) {
        const err = new Error('not found');
        err.status = 404;
        throw err;
      }
      return q;
    },
    async checkAnswer(questionId, answer) {
      if (throwOnCheck) throw new Error('question component unreachable');
      const q = bank.find((x) => String(x.id) === String(questionId));
      if (!q) {
        const err = new Error('not found');
        err.status = 404;
        throw err;
      }
      return { questionId, correct: String(answer) === String(q.correctOption) };
    },
    async health() {
      return healthy;
    },
  };
}

module.exports = {
  FakePgPool,
  FakeRedisClient,
  createFakeCache,
  createFakeMessaging,
  createFakeSearch,
  createFakeQuestionClient,
};
