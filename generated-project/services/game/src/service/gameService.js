'use strict';

const { Game } = require('../domain/game');

/**
 * GameService - the application/use-case layer behind GameComponent.
 *
 * It is a thin wrapper around the domain Game class so that the component name
 * in the ComponentDiagram ("GameComponent") and the class name in the
 * ClassDiagram ("Game") are both real, findable symbols (see traceability
 * matrix, FR-1 and NFR-1).
 */
class GameService {
  constructor({ repository, questionClient, messaging, metrics, logger, config }) {
    this.repository = repository;
    this.questionClient = questionClient;
    this.messaging = messaging;
    this.metrics = metrics;
    this.logger = logger;
    this.config = config;
  }

  /**
   * FR-1 "Play game" / UseCaseDiagram (PlayGame):
   * create a new game, pull a round of questions from QuestionComponent and
   * persist the initial state.
   */
  async startGame({ userId = null, username = null, questionCount = 10, difficulty = null } = {}) {
    const questions = await this.loadQuestions({ questionCount, difficulty });

    const game = new Game({
      user: userId ? { id: userId, username } : username ? { id: null, username } : null,
      questions,
    });
    game.play();

    await this.repository.save(game);

    if (this.metrics) this.metrics.gamesStarted.inc({ mode: difficulty || 'standard' });
    if (this.messaging) {
      await this.messaging.publish(this.config.rabbitmq.events.gameStarted, {
        gameId: game.id,
        userId,
        questionCount: questions.length,
        difficulty: difficulty || 'standard',
      });
    }

    return {
      gameId: game.id,
      state: game.state,
      score: game.score,
      totalQuestions: game.totalQuestions,
      question: this.publicQuestion(game.currentQuestion),
    };
  }

  /**
   * Question selection. If QuestionComponent is unreachable we fall back to a
   * locally generated fraction set so a lesson is never blocked - documented in
   * README -> "Underspecified areas" (the spec never defines the question bank).
   */
  async loadQuestions({ questionCount, difficulty }) {
    if (this.questionClient) {
      try {
        const remote = await this.questionClient.listQuestions({ count: questionCount, difficulty });
        if (Array.isArray(remote) && remote.length > 0) {
          return remote.map(normaliseQuestion);
        }
      } catch (err) {
        this.logger && this.logger.warn(
          { err: err.message },
          'falling back to built-in fraction question set',
        );
      }
    }
    return buildDefaultQuestionSet(questionCount);
  }

  async requireGame(gameId) {
    const game = await this.repository.findById(gameId);
    if (!game) {
      const err = new Error(`Game ${gameId} not found`);
      err.status = 404;
      err.code = 'game_not_found';
      throw err;
    }
    return game;
  }

  /** SequenceDiagram1: Game ->> User : display prompt */
  async getPrompt(gameId) {
    const game = await this.requireGame(gameId);
    return {
      gameId: game.id,
      state: game.state,
      score: game.score,
      progress: { answered: game.answeredCount, total: game.totalQuestions },
      question: this.publicQuestion(game.currentQuestion),
    };
  }

  /**
   * SequenceDiagram1 continuation: User ->> Game : submit answer,
   * Game ->> Question : check answer, Question ->> Game : return result,
   * Game ->> User : display result.
   *
   * Authoritative grading is delegated to QuestionComponent when reachable, and
   * falls back to the composition copy of the question held by the Game.
   */
  async submitAnswer(gameId, { questionId, answer, timeMs = null, userId = null }) {
    const game = await this.requireGame(gameId);
    const question = game.questions.find((q) => q.id === questionId);
    if (!question) {
      const err = new Error(`Question ${questionId} is not part of game ${gameId}`);
      err.status = 404;
      err.code = 'question_not_in_game';
      throw err;
    }

    let graded;
    if (this.questionClient) {
      try {
        graded = await this.questionClient.checkAnswer(questionId, answer);
      } catch (err) {
        this.logger && this.logger.warn(
          { err: err.message, questionId },
          'remote grading unavailable; grading against cached question',
        );
      }
    }
    const correct = graded && typeof graded.correct === 'boolean'
      ? graded.correct
      : String(answer).trim() === String(question.correctOption).trim();

    const result = game.submitAnswer({ questionId, answer, timeMs: timeMs ?? null });
    result.correct = correct;
    result.awarded = correct ? result.awarded : 0;
    if (!correct) game.score -= 0; // no penalty; keeps intent explicit

    // Advance the cursor for the next prompt.
    game.currentIndex = Math.min(game.answeredCount, Math.max(game.totalQuestions - 1, 0));

    await this.repository.save(game);

    if (this.metrics) this.metrics.recordAnswer(correct);
    if (this.messaging) {
      await this.messaging.publish(this.config.rabbitmq.events.answerSubmitted, {
        gameId: game.id,
        questionId,
        userId: userId || (game.user && game.user.id) || null,
        correct,
        score: game.score,
      });
    }

    const payload = {
      gameId: game.id,
      correct: result.correct,
      correctOption: result.correctOption,
      awarded: result.awarded,
      score: game.score,
      state: game.state,
      progress: { answered: game.answeredCount, total: game.totalQuestions },
      question: this.publicQuestion(game.currentQuestion),
    };

    if (game.isOver) {
      payload.feedback = game.feedback();
      if (this.metrics) {
        this.metrics.gamesCompleted.inc({ outcome: game.feedback().accuracy >= 0.5 ? 'pass' : 'retry' });
        const engagement =
          (Date.parse(game.endedAt) - Date.parse(game.startedAt)) / 1000;
        if (Number.isFinite(engagement) && engagement >= 0) {
          this.metrics.userEngagementSeconds.observe({ completed: 'true' }, engagement);
        }
      }
      if (this.messaging) {
        await this.messaging.publish(this.config.rabbitmq.events.gameCompleted, {
          gameId: game.id,
          userId: (game.user && game.user.id) || null,
          score: game.score,
          accuracy: game.feedback().accuracy,
        });
      }
    }

    return payload;
  }

  /** UseCaseDiagram (ViewScore) / ClassDiagram: viewScore(game: Game): int */
  async viewScore(gameId) {
    const game = await this.requireGame(gameId);
    return { gameId: game.id, score: game.viewScore(), ...game.feedback() };
  }

  /** StateDiagram: pause() */
  async pause(gameId) {
    const game = await this.requireGame(gameId);
    game.pause();
    await this.repository.save(game);
    return { gameId: game.id, state: game.state };
  }

  /** StateDiagram: resume() */
  async resume(gameId) {
    const game = await this.requireGame(gameId);
    game.resume();
    await this.repository.save(game);
    return { gameId: game.id, state: game.state };
  }

  /** StateDiagram: gameOver() */
  async gameOver(gameId) {
    const game = await this.requireGame(gameId);
    game.gameOver();
    await this.repository.save(game);
    if (this.metrics) this.metrics.gamesCompleted.inc({ outcome: 'abandoned' });
    return { gameId: game.id, state: game.state, feedback: game.feedback() };
  }

  async leaderboard({ userId = null, limit = 10 } = {}) {
    const rows = await this.repository.topScores(userId, limit);
    return { entries: rows, limit };
  }

  /** UseCaseDiagram (ViewHelp) - static lesson help content. */
  viewHelp() {
    return {
      topic: 'Fractions',
      steps: [
        'A fraction shows equal parts of a whole: the top number is the numerator, the bottom is the denominator.',
        'To add or subtract fractions, first make the denominators the same.',
        'To multiply fractions, multiply numerators together and denominators together.',
        'To divide by a fraction, multiply by its reciprocal.',
      ],
      tips: [
        'Simplify your answer whenever the numerator and denominator share a factor.',
        'Compare fractions by cross-multiplying.',
      ],
    };
  }

  /** Never leak correctOption to the student before they answer. */
  publicQuestion(question) {
    if (!question) return null;
    return {
      id: question.id,
      prompt: question.prompt,
      options: question.options,
      difficulty: question.difficulty || null,
      index: undefined,
    };
  }
}

function normaliseQuestion(q) {
  return {
    id: String(q.id),
    prompt: q.prompt,
    options: Array.isArray(q.options) ? q.options : [],
    correctOption: q.correctOption,
    difficulty: q.difficulty || null,
    weight: Number.isFinite(q.weight) ? q.weight : 1,
  };
}

/**
 * Built-in fallback question bank. Kept deliberately identical to the
 * QuestionComponent seed set (services/question/src/service/seedQuestions.js)
 * so grading is consistent whether questions arrive over the wire or come from
 * the local fallback. The two services are separately deployable, so the data
 * is duplicated rather than shared - see README -> "Underspecified areas".
 */
const FALLBACK_BANK = [
  { prompt: 'What is 1/2 + 1/4?', options: ['2/6', '3/4', '1/6', '2/4'], correctOption: '3/4' },
  { prompt: 'What is 2/3 - 1/6?', options: ['1/3', '1/2', '1/6', '3/6'], correctOption: '1/2' },
  { prompt: 'What is 3/5 x 10/9?', options: ['2/3', '30/45', '13/14', '1/2'], correctOption: '2/3' },
  { prompt: 'Which fraction is largest?', options: ['2/3', '3/5', '5/8', '1/2'], correctOption: '2/3' },
  { prompt: 'What is 4/7 divided by 2/7?', options: ['2', '8/49', '1/2', '6/7'], correctOption: '2' },
  { prompt: 'Simplify 18/24.', options: ['2/3', '3/4', '6/8', '9/12'], correctOption: '3/4' },
  { prompt: 'What is 5/6 + 1/3?', options: ['6/9', '7/6', '1 1/6', '2/3'], correctOption: '1 1/6' },
  { prompt: 'What is 7/8 - 1/4?', options: ['5/8', '6/8', '1/2', '3/4'], correctOption: '5/8' },
  { prompt: 'Which is equivalent to 2/5?', options: ['4/10', '3/8', '2/10', '5/2'], correctOption: '4/10' },
  { prompt: 'What is 1/3 of 3/4?', options: ['1/4', '3/12', '1/12', '4/3'], correctOption: '1/4' },
];

/**
 * Build `count` questions with stable ids, cycling the fallback bank. Difficulty
 * and weight are derived from position so a 10-question round ramps up.
 */
function buildDefaultQuestionSet(count = 10) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const q = FALLBACK_BANK[i % FALLBACK_BANK.length];
    const difficulty = i < 4 ? 'easy' : i < 8 ? 'medium' : 'hard';
    out.push({
      id: `builtin-${i + 1}`,
      prompt: q.prompt,
      options: q.options.slice(),
      correctOption: q.correctOption,
      difficulty,
      weight: difficulty === 'hard' ? 2 : difficulty === 'medium' ? 1.5 : 1,
    });
  }
  return out;
}

module.exports = { GameService, buildDefaultQuestionSet, normaliseQuestion, FALLBACK_BANK };
