'use strict';

const { request } = require('@spacefractions/shared').http;

/**
 * QuestionComponentClient - GameComponent -> QuestionComponent REST calls.
 *
 * The SequenceDiagram (spec.json view 6 "SequenceDiagram1") is explicit:
 *   User   ->> Game     : play()
 *   Game   ->> Question : getPrompt()
 *   Question ->> Game   : return prompt
 *   Game   ->> User     : display prompt
 *   User   ->> Game     : submit answer
 *   Game   ->> Question : check answer
 *   Question ->> Game   : return result
 *   Game   ->> User     : display result
 *
 * Both getPrompt() and checkAnswer() map onto QuestionComponent's public REST
 * API, so the game can run whether questions are local or remote.
 */
class QuestionComponentClient {
  constructor({ baseUrl, logger, metrics = null, timeoutMs = 3000 }) {
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.logger = logger;
    this.metrics = metrics;
    this.timeoutMs = timeoutMs;
  }

  async call(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const op = () => request(url, { timeoutMs: this.timeoutMs, ...options });
    try {
      const res = this.metrics
        ? await this.metrics.timeExternal('question-component', options.method || 'GET', op)
        : await op();
      return res.body;
    } catch (err) {
      this.logger && this.logger.warn({ err: err.message, url }, 'QuestionComponent call failed');
      throw err;
    }
  }

  /** SequenceDiagram1: Game ->> Question : getPrompt() */
  async getPrompt(questionId) {
    return this.call(`/api/v1/questions/${encodeURIComponent(questionId)}`);
  }

  /** SequenceDiagram1: Game ->> Question : check answer -> return result */
  async checkAnswer(questionId, answer) {
    return this.call(`/api/v1/questions/${encodeURIComponent(questionId)}/check`, {
      method: 'POST',
      body: { answer },
    });
  }

  /** Fetch a round of questions to compose a game. */
  async listQuestions({ count = 10, difficulty = null } = {}) {
    const params = new URLSearchParams({ limit: String(count) });
    if (difficulty) params.set('difficulty', difficulty);
    const body = await this.call(`/api/v1/questions?${params.toString()}`);
    return body.questions || body.items || [];
  }

  async health() {
    try {
      const res = await this.call('/health');
      return res && res.status === 'UP';
    } catch (_) {
      return false;
    }
  }
}

module.exports = { QuestionComponentClient };
