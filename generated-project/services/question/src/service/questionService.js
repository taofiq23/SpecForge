'use strict';

const { Question } = require('../domain/question');
const { buildDefaultQuestionSet } = require('./seedQuestions');

/**
 * QuestionService - application layer behind QuestionComponent.
 *
 * Responsibilities (spec section C): "question management and data persistence".
 * ASR-1 (data durability) is satisfied by QuestionRepository + PostgreSQL.
 *
 * The SequenceDiagram2 (spec.json view 6, "SequenceDiagram2") is:
 *   Admin ->> Question : update()
 *   Question ->> Admin : return success
 * and SequenceDiagram1 requires getPrompt() and check answer.
 */
class QuestionService {
  constructor({ repository, messaging, metrics, logger, config }) {
    this.repository = repository;
    this.messaging = messaging;
    this.metrics = metrics;
    this.logger = logger;
    this.config = config;
  }

  /** SequenceDiagram2: Admin ->> Question : update() */
  async create(input) {
    const question = new Question(input);
    const validation = question.validate();
    if (!validation.valid) {
      const err = new Error(validation.errors.join('; '));
      err.status = 400;
      err.code = 'invalid_question';
      throw err;
    }
    const row = await this.repository.insert(question);
    if (this.messaging) {
      await this.messaging.publish(this.config.rabbitmq.events.questionUpdated, {
        questionId: question.id,
        action: 'created',
        version: 1,
      });
    }
    return { ...question.toJSON(), ...mapRow(row) };
  }

  async update(questionId, patch) {
    const row = await this.repository.update(questionId, patch);
    if (!row) {
      const err = new Error(`Question ${questionId} not found`);
      err.status = 404;
      err.code = 'question_not_found';
      throw err;
    }
    if (this.messaging) {
      await this.messaging.publish(this.config.rabbitmq.events.questionUpdated, {
        questionId,
        action: 'updated',
        version: row.version,
      });
    }
    const question = await this.repository.findById(questionId, { bypassCache: true });
    return question.toJSON();
  }

  async getPrompt(questionId) {
    const question = await this.repository.findById(questionId);
    if (!question) {
      const err = new Error(`Question ${questionId} not found`);
      err.status = 404;
      err.code = 'question_not_found';
      throw err;
    }
    return question.toPublicJSON();
  }

  /** SequenceDiagram1: Question ->> Game : return result */
  async checkAnswer(questionId, answer) {
    const question = await this.repository.findById(questionId);
    if (!question) {
      const err = new Error(`Question ${questionId} not found`);
      err.status = 404;
      err.code = 'question_not_found';
      throw err;
    }
    const result = question.checkAnswer(answer);
    if (this.metrics) this.metrics.recordAnswer(result.correct);
    if (this.messaging) {
      await this.messaging.publish(this.config.rabbitmq.events.answerSubmitted, {
        questionId,
        correct: result.correct,
        // Deliberately no free-text answer forwarded: ASR-2 (security) and
        // student privacy. Only the outcome and reason are published.
        reason: result.reason,
      });
    }
    return { questionId, ...result };
  }

  async list({ limit = 10, offset = 0, difficulty = null } = {}) {
    const [questions, total] = await Promise.all([
      this.repository.list({ limit, offset, difficulty }),
      this.repository.count(),
    ]);
    return {
      questions: questions.map((q) => q.toPublicJSON()),
      total,
      limit,
      offset,
    };
  }

  /** Admin listing includes answer keys. */
  async listForAdmin({ limit = 50, offset = 0, difficulty = null } = {}) {
    const questions = await this.repository.list({ limit, offset, difficulty, activeOnly: false });
    return { questions: questions.map((q) => q.toJSON()), total: await this.repository.count({ activeOnly: false }) };
  }

  /** Elasticsearch-backed free-text search (NFR-1 performance). */
  async search(query, size = 20) {
    if (!this.repository.search) return { results: [], total: 0, engine: 'unavailable' };
    const hits = await this.repository.search.search(query, size);
    return { results: hits, total: hits.length, engine: 'elasticsearch', query };
  }

  async remove(questionId) {
    const removed = await this.repository.remove(questionId);
    if (!removed) {
      const err = new Error(`Question ${questionId} not found`);
      err.status = 404;
      err.code = 'question_not_found';
      throw err;
    }
    if (this.messaging) {
      await this.messaging.publish(this.config.rabbitmq.events.questionUpdated, {
        questionId,
        action: 'deactivated',
      });
    }
    return { questionId, active: false, message: 'Question deactivated' };
  }

  /**
   * Seed / recover the question bank. ASR-1 requires question data to be
   * "persisted and recoverable", so this doubles as a recovery path: if the
   * table is empty (e.g. after a restore) it repopulates from the canonical set.
   */
  async seed({ force = false } = {}) {
    const existing = await this.repository.count({ activeOnly: false });
    if (existing > 0 && !force) {
      return { seeded: 0, existing, skipped: true };
    }
    const defaults = buildDefaultQuestionSet(20);
    let seeded = 0;
    for (const q of defaults) {
      const question = new Question(q);
      const validation = question.validate();
      if (!validation.valid) {
        this.logger && this.logger.warn({ errors: validation.errors }, 'skipping invalid seed question');
        continue;
      }
      // Deterministic ids so re-seeding after a restore is idempotent.
      await this.repository.pool.query(
        `INSERT INTO ${this.repository.table}
           (question_uid, prompt, options, correct_option, difficulty, weight, tags, active)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7::jsonb,$8)
         ON CONFLICT (question_uid) DO NOTHING`,
        [
          `seed-${seeded + 1}`,
          question.prompt,
          JSON.stringify(question.options),
          question.correctOption,
          question.difficulty,
          question.weight,
          JSON.stringify(question.tags),
          true,
        ],
      );
      if (this.repository.search) {
        await this.repository.search.indexDocument(`seed-${seeded + 1}`, {
          id: `seed-${seeded + 1}`,
          prompt: question.prompt,
          options: question.options,
          correctOption: question.correctOption,
          difficulty: question.difficulty,
          tags: question.tags,
        });
      }
      seeded += 1;
    }
    return { seeded, existing, skipped: false };
  }

  /** ASR-1 observability: expose durability posture to operators. */
  async durabilityStatus() {
    const [replication, recoveryPoint, count] = await Promise.all([
      this.repository.replicationStatus(),
      this.repository.recoveryPoint(),
      this.repository.count({ activeOnly: false }),
    ]);
    return {
      component: 'QuestionComponent',
      requirement: 'ASR-1',
      persistedQuestions: count,
      replication,
      recoveryPoint,
      rpoTargetHours: 1,
      rtoTargetHours: 1,
    };
  }
}

function mapRow(row) {
  if (!row) return {};
  return { version: row.version, updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined };
}

module.exports = { QuestionService };
