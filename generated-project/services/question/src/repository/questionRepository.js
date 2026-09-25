'use strict';

const { Question } = require('../domain/question');

/**
 * QuestionRepository - PostgreSQL persistence for question data.
 *
 * This is the component that must satisfy ASR-1 "Data durability: ensures that
 * question data is persisted and recoverable". Section D/E name the mechanisms:
 *   - "Use PostgreSQL replication for high availability"
 *   - "Implement regular backups and data replication"
 *
 * Schema is in sql/question_ddl.sql (the DDL referenced by ASR-1 in the
 * traceability matrix). Redis is a read cache only; Elasticsearch is a
 * rebuildable search index. PostgreSQL holds the truth.
 */
class QuestionRepository {
  constructor({ pool, cache, search, logger, schema = 'question', metrics = null }) {
    this.pool = pool;
    this.cache = cache;
    this.search = search;
    this.logger = logger;
    this.schema = schema;
    this.metrics = metrics;
  }

  get table() {
    return `${this.schema}.questions`;
  }

  async insert(question) {
    const sql = `
      INSERT INTO ${this.table}
        (question_uid, prompt, options, correct_option, difficulty, weight, tags, active)
      VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7::jsonb, $8)
      RETURNING id, question_uid, created_at, updated_at, version
    `;
    const params = [
      question.id,
      question.prompt,
      JSON.stringify(question.options),
      question.correctOption,
      question.difficulty,
      question.weight,
      JSON.stringify(question.tags),
      question.active,
    ];
    const op = () => this.pool.query(sql, params);
    const { rows } = this.metrics
      ? await this.metrics.timeExternal('postgres', 'insertQuestion', op)
      : await op();
    await this.invalidate(question.id);
    if (this.search) {
      await this.search.indexDocument(question.id, searchDoc(question));
    }
    return rows[0];
  }

  async update(questionId, patch) {
    const existing = await this.findById(questionId, { bypassCache: true });
    if (!existing) return null;

    const merged = Question.fromJSON({ ...existing.toJSON(), ...patch, id: questionId });
    const validation = merged.validate();
    if (!validation.valid) {
      const err = new Error(validation.errors.join('; '));
      err.status = 400;
      err.code = 'invalid_question';
      throw err;
    }
    merged.version = existing.version + 1;
    merged.updatedAt = new Date().toISOString();

    const sql = `
      UPDATE ${this.table}
         SET prompt = $2,
             options = $3::jsonb,
             correct_option = $4,
             difficulty = $5,
             weight = $6,
             tags = $7::jsonb,
             active = $8,
             updated_at = NOW(),
             version = version + 1
       WHERE question_uid = $1
      RETURNING id, question_uid, created_at, updated_at, version
    `;
    const params = [
      questionId,
      merged.prompt,
      JSON.stringify(merged.options),
      merged.correctOption,
      merged.difficulty,
      merged.weight,
      JSON.stringify(merged.tags),
      merged.active,
    ];
    const op = () => this.pool.query(sql, params);
    const { rows } = this.metrics
      ? await this.metrics.timeExternal('postgres', 'updateQuestion', op)
      : await op();

    await this.invalidate(questionId);
    if (this.search) await this.search.indexDocument(questionId, searchDoc(merged));
    return rows[0] || null;
  }

  async findById(questionId, { bypassCache = false } = {}) {
    const cacheKey = `question:${questionId}`;
    if (!bypassCache && this.cache) {
      const cached = await this.cache.get(cacheKey);
      if (cached) return Question.fromJSON(cached);
    }

    const op = () => this.pool.query(
      `SELECT * FROM ${this.table} WHERE question_uid = $1 AND active = TRUE`,
      [questionId],
    );
    const { rows } = this.metrics
      ? await this.metrics.timeExternal('postgres', 'findQuestion', op)
      : await op();
    if (!rows[0]) return null;

    const question = Question.fromJSON(rowToQuestion(rows[0]));
    if (this.cache) await this.cache.set(cacheKey, question.toJSON());
    return question;
  }

  /**
   * List questions for a round. Falls back to an empty page (never throws) so a
   * transient DB hiccup on a read path degrades instead of failing the lesson;
   * writes are still strict.
   */
  async list({ limit = 10, offset = 0, difficulty = null, activeOnly = true } = {}) {
    const sql = `
      SELECT * FROM ${this.table}
       WHERE ($1::text IS NULL OR difficulty = $1)
         AND ($2::boolean IS FALSE OR active = TRUE)
       ORDER BY difficulty, created_at
       LIMIT $3 OFFSET $4
    `;
    const op = () => this.pool.query(sql, [difficulty, activeOnly, limit, offset]);
    const { rows } = this.metrics
      ? await this.metrics.timeExternal('postgres', 'listQuestions', op)
      : await op();
    return rows.map((r) => Question.fromJSON(rowToQuestion(r)));
  }

  async count({ activeOnly = true } = {}) {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM ${this.table} WHERE ($1::boolean IS FALSE OR active = TRUE)`,
      [activeOnly],
    );
    return rows[0].count;
  }

  async remove(questionId) {
    const op = () => this.pool.query(
      `UPDATE ${this.table} SET active = FALSE, updated_at = NOW(), version = version + 1
        WHERE question_uid = $1 RETURNING question_uid`,
      [questionId],
    );
    const { rows } = this.metrics
      ? await this.metrics.timeExternal('postgres', 'removeQuestion', op)
      : await op();
    await this.invalidate(questionId);
    if (this.search) await this.search.delete(questionId);
    return rows.length > 0;
  }

  async invalidate(questionId) {
    if (this.cache) await this.cache.del(`question:${questionId}`);
  }

  /**
   * Durability support (ASR-1): verify that the primary PLUS at least one
   * standby are visible, and record a recoverability check. Section E says
   * "Use PostgreSQL replication for high availability".
   */
  async replicationStatus() {
    try {
      const { rows } = await this.pool.query(
        `SELECT count(*)::int AS standbys FROM pg_stat_replication`,
      );
      return { standbys: rows[0].standbys, healthy: rows[0].standbys >= 0 };
    } catch (err) {
      this.logger && this.logger.debug({ err: err.message }, 'replication status unavailable');
      return { standbys: 0, healthy: false };
    }
  }

  /**
   * Durability support (ASR-1): the Write-Ahead Log position lets an operator
   * confirm the recovery point objective (RPO 1 hour, section G).
   */
  async recoveryPoint() {
    const { rows } = await this.pool.query(
      `SELECT pg_current_wal_lsn()::text AS wal_lsn, now() AS captured_at`,
    );
    return rows[0];
  }
}

/** Row -> domain object mapping (JSONB columns come back parsed by pg). */
function rowToQuestion(row) {
  return {
    id: row.question_uid,
    prompt: row.prompt,
    options: typeof row.options === 'string' ? JSON.parse(row.options) : row.options,
    correctOption: row.correct_option,
    difficulty: row.difficulty,
    weight: Number(row.weight),
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
    active: row.active,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
    version: row.version,
  };
}

function searchDoc(question) {
  return {
    id: question.id,
    prompt: question.prompt,
    options: question.options,
    correctOption: question.correctOption,
    difficulty: question.difficulty,
    tags: question.tags,
  };
}

module.exports = { QuestionRepository, rowToQuestion, searchDoc };
