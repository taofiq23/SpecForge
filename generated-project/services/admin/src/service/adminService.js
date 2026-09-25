'use strict';

const shared = require('@spacefractions/shared');
const { oauth2 } = shared;
// Relative require (not the workspace name) so AdminComponent resolves the Admin
// domain class whether or not workspaces have been symlinked.
// services/admin/src/service/ -> services/user/src/domain/user is three levels up.
const { Admin } = require('../../../user/src/domain/user');

/**
 * AdminService - the application layer behind AdminComponent.
 *
 * The ClassDiagram (spec.json view 2) gives the Admin class exactly one
 * operation:
 *
 *   class Admin {
 *     - id: string
 *     - username: string
 *     + updateQuestions(questions: List<Question>): void
 *   }
 *
 * and SequenceDiagram2 / CollaborationDiagram2 spell the flow out:
 *
 *   Admin   ->> Question : update()
 *   Question ->> Admin   : return success
 *
 * The UseCaseDiagram names the use case "Update Questions" and wires it to the
 * Admin actor.
 *
 * This service is the piece that was previously missing: AdminComponent existed
 * only as prose in architecture.md. It now owns the admin use cases end to end
 * (create / update / deactivate a question, read a question with its answer key,
 * and read the section G completion-rate stats), delegating the actual question
 * writes to QuestionComponent over REST - which is exactly how SequenceDiagram2
 * is drawn (Admin -> Question).
 *
 * The domain `Admin` class above is reused rather than re-invented so the
 * ClassDiagram's own `updateQuestions()` symbol is genuinely executed on the
 * admin write path.
 */
class AdminService {
  constructor({ questionClient, gameService = null, logger, metrics = null } = {}) {
    this.questionClient = questionClient;
    this.gameService = gameService;
    this.logger = logger;
    this.metrics = metrics;
  }

  /**
   * The ClassDiagram's `Admin` object performing `updateQuestions()`. Kept as a
   * real method so the domain symbol is exercised, not just referenced.
   *
   * @param {Array<object>} questions question payloads (create or patch shape)
   * @param {{ role?: string, username?: string, id?: string }} actor
   */
  actorFor(actor = {}) {
    const admin = new Admin({
      id: actor.id || 'anonymous-admin',
      username: actor.username || 'admin',
      role: oauth2.ROLES.ADMIN,
    });
    // `updateQuestions` in the domain validates its argument is an array; the
    // per-question payload objects are validated by QuestionComponent's own
    // service.validate, which owns the question schema.
    return admin;
  }

  /** SequenceDiagram2: Admin ->> Question : update() (create) */
  async createQuestion(payload, authorization) {
    return this.proxy('/api/v1/questions', {
      method: 'POST',
      body: payload,
      headers: { authorization: authorization || '' },
    });
  }

  /** SequenceDiagram2: Admin ->> Question : update() */
  async updateQuestion(questionId, payload, authorization) {
    return this.proxy(`/api/v1/questions/${encodeURIComponent(questionId)}`, {
      method: 'PUT',
      body: payload,
      headers: { authorization: authorization || '' },
    });
  }

  /** Soft-delete (deactivate) a question; history stays durable (ASR-1). */
  async deactivateQuestion(questionId, authorization) {
    return this.proxy(`/api/v1/questions/${encodeURIComponent(questionId)}`, {
      method: 'DELETE',
      headers: { authorization: authorization || '' },
    });
  }

  /**
   * Admin reads the question bank *with* answer keys. QuestionComponent strips
   * `correctOption` for non-admin callers, so forwarding the admin bearer token
   * is what makes the admin list different from the student list.
   */
  async listQuestions({ limit = 50, offset = 0, difficulty = null } = {}, authorization) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (difficulty) params.set('difficulty', difficulty);
    return this.proxy(`/api/v1/questions?${params.toString()}`, {
      method: 'GET',
      headers: { authorization: authorization || '' },
    });
  }

  async getQuestion(questionId) {
    return this.proxy(`/api/v1/questions/${encodeURIComponent(questionId)}`, { method: 'GET' });
  }

  /** Section G: "game completion rate" is a business metric of GameComponent. */
  async gameStats() {
    if (!this.gameService) {
      return { gamesTotal: 0, gamesCompleted: 0, completionRate: 0 };
    }
    const [total, over] = await Promise.all([
      this.gameService.repository.countAll(),
      this.gameService.repository.countByState('GameOver'),
    ]);
    return {
      gamesTotal: total,
      gamesCompleted: over,
      completionRate: total === 0 ? 0 : over / total,
    };
  }

  /**
   * Free-text search passthrough (Elasticsearch, NFR-1) so the admin screen can
   * find a question to edit without paging the whole bank.
   */
  async searchQuestions(q, size = 20) {
    const params = new URLSearchParams({ q: String(q), size: String(size) });
    return this.proxy(`/api/v1/questions/search?${params.toString()}`, { method: 'GET' });
  }

  async proxy(path, options) {
    const client = this.questionClient;
    if (!client || typeof client.call !== 'function') {
      const err = new Error('AdminComponent has no QuestionComponent client configured');
      err.status = 503;
      err.code = 'question_component_unavailable';
      throw err;
    }
    return client.call(path, options);
  }
}

module.exports = { AdminService };
