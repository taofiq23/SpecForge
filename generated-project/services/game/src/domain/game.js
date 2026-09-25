'use strict';

const { GAME_STATES, ALL_GAME_STATES, newId } = require('@spacefractions/shared').domain;

/**
 * Game - the class named in the ClassDiagram (spec.json view 2):
 *
 *   class Game {
 *     - id: string
 *     - score: int
 *     + play(): void
 *     + viewScore(): int
 *   }
 *
 * The StateDiagram (spec.json view 4) drives the transition table:
 *   [*] --> Playing
 *   Playing --> Paused   : pause()
 *   Paused  --> Playing  : resume()
 *   Playing --> GameOver : gameOver()
 *
 * Game --* Question (composition) from the class diagram: a game owns the
 * ordered list of questions it will serve, so scoring is deterministic.
 */
class Game {
  /**
   * @param {object} props
   * @param {string} [props.id]
   * @param {number} [props.score]
   * @param {string} [props.state]
   * @param {object} [props.user]
   * @param {Array<{id:string,prompt:string,options:string[],correctOption:string}>} [props.questions]
   */
  constructor(props = {}) {
    this.id = props.id || newId();
    this.score = Number.isInteger(props.score) ? props.score : 0;
    this.state = ALL_GAME_STATES.includes(props.state) ? props.state : GAME_STATES.PLAYING;
    this.user = props.user || null;
    // Game --* Question : composition, so questions are owned values here.
    this.questions = Array.isArray(props.questions) ? props.questions : [];
    this.answers = Array.isArray(props.answers) ? props.answers : [];
    this.currentIndex = Number.isInteger(props.currentIndex) ? props.currentIndex : 0;
    this.startedAt = props.startedAt || new Date().toISOString();
    this.endedAt = props.endedAt || null;
    this.updatedAt = new Date().toISOString();
  }

  /** ClassDiagram: + play(): void - transitions the game into Playing. */
  play() {
    if (this.state === GAME_STATES.GAME_OVER) {
      const err = new Error('Cannot play a game that is already over');
      err.status = 409;
      err.code = 'game_already_over';
      throw err;
    }
    this.state = GAME_STATES.PLAYING;
    this.touch();
    return this.state;
  }

  /** StateDiagram: pause() */
  pause() {
    if (this.state !== GAME_STATES.PLAYING) {
      return this.badTransition(GAME_STATES.PAUSED);
    }
    this.state = GAME_STATES.PAUSED;
    this.touch();
    return this.state;
  }

  /** StateDiagram: resume() */
  resume() {
    if (this.state !== GAME_STATES.PAUSED) {
      return this.badTransition(GAME_STATES.PLAYING);
    }
    this.state = GAME_STATES.PLAYING;
    this.touch();
    return this.state;
  }

  /** StateDiagram: gameOver() - no transitions out of GameOver. */
  gameOver() {
    if (this.state === GAME_STATES.GAME_OVER) return this.state;
    this.state = GAME_STATES.GAME_OVER;
    this.endedAt = new Date().toISOString();
    this.touch();
    return this.state;
  }

  badTransition(target) {
    const err = new Error(`Illegal transition from ${this.state} to ${target}`);
    err.status = 409;
    err.code = 'illegal_state_transition';
    throw err;
  }

  /** ClassDiagram: + viewScore(): int */
  viewScore() {
    return this.score;
  }

  get currentQuestion() {
    return this.questions[this.currentIndex] || null;
  }

  /** ActivityDiagram (view 5): "if (game over?) ... :calculate score;" */
  get isOver() {
    return this.state === GAME_STATES.GAME_OVER;
  }

  get answeredCount() {
    return this.answers.length;
  }

  get totalQuestions() {
    return this.questions.length;
  }

  /**
   * Record an answer. Scoring rule chosen by us (the spec names a score but
   * never defines the formula - see README):
   *   correct answer   -> +10 * difficultyWeight (default 1) points
   *   incorrect answer -> no points, no penalty (it is a learning tool)
   * The game ends automatically once every question is answered.
   */
  submitAnswer({ questionId, answer, timeMs = null }) {
    if (this.state === GAME_STATES.GAME_OVER) {
      const err = new Error('Cannot submit an answer to a finished game');
      err.status = 409;
      err.code = 'game_already_over';
      throw err;
    }
    if (this.state === GAME_STATES.PAUSED) {
      const err = new Error('Game is paused; resume before answering');
      err.status = 409;
      err.code = 'game_paused';
      throw err;
    }

    const index = this.questions.findIndex((q) => q.id === questionId);
    if (index === -1) {
      const err = new Error(`Question ${questionId} is not part of game ${this.id}`);
      err.status = 404;
      err.code = 'question_not_in_game';
      throw err;
    }
    if (this.answers.some((a) => a.questionId === questionId)) {
      const err = new Error(`Question ${questionId} has already been answered in this game`);
      err.status = 409;
      err.code = 'question_already_answered';
      throw err;
    }

    const question = this.questions[index];
    const correct = String(answer).trim() === String(question.correctOption).trim();
    const weight = Number.isFinite(question.weight) ? question.weight : 1;
    const awarded = correct ? 10 * weight : 0;

    this.score += awarded;
    this.answers.push({
      questionId,
      answer,
      correct,
      awarded,
      timeMs: Number.isFinite(timeMs) ? timeMs : null,
      answeredAt: new Date().toISOString(),
    });

    if (this.answers.length >= this.questions.length && this.questions.length > 0) {
      this.gameOver();
    }

    this.touch();
    return { correct, awarded, correctOption: question.correctOption, score: this.score };
  }

  /** ClassDiagram: User + viewScore(game: Game): int -> feedback block. */
  feedback() {
    const total = this.questions.length;
    const correct = this.answers.filter((a) => a.correct).length;
    return {
      gameId: this.id,
      score: this.score,
      state: this.state,
      answered: this.answers.length,
      totalQuestions: total,
      correctAnswers: correct,
      accuracy: total === 0 ? 0 : correct / total,
      completed: this.isOver,
      message: this.completionMessage(correct, total),
    };
  }

  completionMessage(correct, total) {
    if (total === 0) return 'No questions were available for this round.';
    const ratio = correct / total;
    if (ratio === 1) return 'Perfect! You are a fraction astronaut!';
    if (ratio >= 0.8) return 'Great work! You have a strong grasp of fractions.';
    if (ratio >= 0.5) return 'Good effort. Review the ones you missed and try again.';
    return 'Keep practising. Fractions take a few orbits to master!';
  }

  /** Game state is what gets cached in Redis and persisted as JSONB. */
  toJSON() {
    return {
      id: this.id,
      score: this.score,
      state: this.state,
      user: this.user,
      questions: this.questions,
      answers: this.answers,
      currentIndex: this.currentIndex,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      updatedAt: this.updatedAt,
    };
  }

  static fromJSON(json) {
    if (!json) return null;
    if (typeof json === 'string') return new Game(JSON.parse(json));
    return new Game(json);
  }

  touch() {
    this.updatedAt = new Date().toISOString();
  }
}

module.exports = { Game };
