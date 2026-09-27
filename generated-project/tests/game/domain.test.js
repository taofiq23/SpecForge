'use strict';

/**
 * GameComponent domain tests.
 *
 * Covers the ClassDiagram's `Game` class (view 2) and the StateDiagram
 * transitions (view 4), plus the ActivityDiagram's "if (game over?)" branch and
 * the scoring rule used by FR-1 (Play game).
 */
const { Game } = require('../../services/game/src/domain/game');
const { GAME_STATES } = require('../../shared/src/domain');

const QUESTIONS = [
  { id: 'q1', prompt: 'What is 1/2 + 1/4?', options: ['2/6', '3/4'], correctOption: '3/4', difficulty: 'easy', weight: 1 },
  { id: 'q2', prompt: 'What is 2/3 - 1/6?', options: ['1/3', '1/2'], correctOption: '1/2', difficulty: 'easy', weight: 1 },
];

describe('Game (ClassDiagram: class Game)', () => {
  test('initialises with id, score and an explicit state', () => {
    const game = new Game({ questions: QUESTIONS });
    expect(typeof game.id).toBe('string');
    expect(game.id.length).toBeGreaterThan(0);
    expect(game.score).toBe(0);
    // [*] --> Playing  (StateDiagram initial state)
    expect(game.state).toBe(GAME_STATES.PLAYING);
    expect(game.totalQuestions).toBe(2);
  });

  test('rejects an unknown state and falls back to Playing', () => {
    const game = new Game({ questions: QUESTIONS, state: 'Teleporting' });
    expect(game.state).toBe(GAME_STATES.PLAYING);
  });

  test('play(): void moves the game into Playing', () => {
    const game = new Game({ questions: QUESTIONS, state: GAME_STATES.PAUSED });
    expect(game.play()).toBe(GAME_STATES.PLAYING);
  });

  test('play() on a finished game raises a 409', () => {
    const game = new Game({ questions: QUESTIONS });
    game.gameOver();
    expect(() => game.play()).toThrow(/already over/);
    try {
      game.play();
    } catch (err) {
      expect(err.status).toBe(409);
      expect(err.code).toBe('game_already_over');
    }
  });

  test('viewScore(): int returns the accumulated score', () => {
    const game = new Game({ questions: QUESTIONS, score: 42 });
    expect(game.viewScore()).toBe(42);
  });
});

describe('Game state machine (StateDiagram)', () => {
  test('Playing -> Paused -> Playing via pause()/resume()', () => {
    const game = new Game({ questions: QUESTIONS });
    expect(game.pause()).toBe(GAME_STATES.PAUSED);
    expect(game.resume()).toBe(GAME_STATES.PLAYING);
  });

  test('pause() from a non-Playing state is an illegal transition', () => {
    const game = new Game({ questions: QUESTIONS });
    game.pause();
    expect(() => game.pause()).toThrow(/Illegal transition from Paused to Paused/);
    try {
      game.pause();
    } catch (err) {
      expect(err.status).toBe(409);
      expect(err.code).toBe('illegal_state_transition');
    }
  });

  test('resume() from Playing is an illegal transition', () => {
    const game = new Game({ questions: QUESTIONS });
    expect(() => game.resume()).toThrow(/Illegal transition from Playing to Playing/);
  });

  test('Playing -> GameOver via gameOver(), with no transitions out', () => {
    const game = new Game({ questions: QUESTIONS });
    expect(game.gameOver()).toBe(GAME_STATES.GAME_OVER);
    expect(game.isOver).toBe(true);
    expect(typeof game.endedAt).toBe('string');
    // Idempotent: calling gameOver() twice does not throw.
    expect(game.gameOver()).toBe(GAME_STATES.GAME_OVER);
  });
});

describe('Game.submitAnswer (ActivityDiagram: calculate score)', () => {
  test('a correct answer awards 10 * weight points', () => {
    const game = new Game({ questions: [{ ...QUESTIONS[0], weight: 2 }] });
    const result = game.submitAnswer({ questionId: 'q1', answer: '3/4' });
    expect(result.correct).toBe(true);
    expect(result.awarded).toBe(20);
    expect(game.score).toBe(20);
  });

  test('an incorrect answer awards nothing and carries no penalty', () => {
    const game = new Game({ questions: QUESTIONS });
    const result = game.submitAnswer({ questionId: 'q1', answer: '2/6' });
    expect(result.correct).toBe(false);
    expect(result.awarded).toBe(0);
    expect(game.score).toBe(0);
  });

  test('a mathematically equivalent fraction is scored correct, matching Question.checkAnswer', () => {
    // Real bug this guards against: submitAnswer used to do an exact string match only, so
    // "6/8" was marked wrong for a correctOption of "3/4" even though they are the same value.
    const game = new Game({ questions: [{ ...QUESTIONS[0], correctOption: '3/4' }] });
    const result = game.submitAnswer({ questionId: 'q1', answer: '6/8' });
    expect(result.correct).toBe(true);
    expect(result.awarded).toBeGreaterThan(0);
  });

  test('answers are compared after trimming whitespace', () => {
    const game = new Game({ questions: QUESTIONS });
    expect(game.submitAnswer({ questionId: 'q1', answer: '  3/4  ' }).correct).toBe(true);
  });

  test('records the client-measured response time for NFR-1 metrics', () => {
    const game = new Game({ questions: QUESTIONS });
    game.submitAnswer({ questionId: 'q1', answer: '3/4', timeMs: 120 });
    expect(game.answers[0].timeMs).toBe(120);
    expect(game.answeredCount).toBe(1);
  });

  test('a non-numeric timeMs is stored as null rather than corrupting the record', () => {
    const game = new Game({ questions: QUESTIONS });
    game.submitAnswer({ questionId: 'q1', answer: '3/4', timeMs: 'soon' });
    expect(game.answers[0].timeMs).toBeNull();
  });

  test('answering a question outside the game is a 404', () => {
    const game = new Game({ questions: QUESTIONS });
    expect(() => game.submitAnswer({ questionId: 'nope', answer: '3/4' })).toThrow(/is not part of game/);
    try {
      game.submitAnswer({ questionId: 'nope', answer: '3/4' });
    } catch (err) {
      expect(err.status).toBe(404);
      expect(err.code).toBe('question_not_in_game');
    }
  });

  test('answering the same question twice is a 409', () => {
    const game = new Game({ questions: QUESTIONS });
    game.submitAnswer({ questionId: 'q1', answer: '3/4' });
    expect(() => game.submitAnswer({ questionId: 'q1', answer: '3/4' })).toThrow(/already been answered/);
  });

  test('a paused game refuses answers until resumed', () => {
    const game = new Game({ questions: QUESTIONS });
    game.pause();
    expect(() => game.submitAnswer({ questionId: 'q1', answer: '3/4' })).toThrow(/paused/);
    game.resume();
    expect(game.submitAnswer({ questionId: 'q1', answer: '3/4' }).correct).toBe(true);
  });

  test('the game ends automatically once every question is answered', () => {
    const game = new Game({ questions: QUESTIONS });
    game.submitAnswer({ questionId: 'q1', answer: '3/4' });
    expect(game.isOver).toBe(false);
    game.submitAnswer({ questionId: 'q2', answer: '1/2' });
    expect(game.isOver).toBe(true);
    expect(game.state).toBe(GAME_STATES.GAME_OVER);
  });

  test('a finished game refuses further answers', () => {
    const game = new Game({ questions: [QUESTIONS[0]] });
    game.submitAnswer({ questionId: 'q1', answer: '3/4' });
    expect(() => game.submitAnswer({ questionId: 'q1', answer: '3/4' })).toThrow(/finished game/);
  });
});

describe('Game.feedback (ending scene)', () => {
  test('reports score, accuracy and a completion message', () => {
    const game = new Game({ questions: QUESTIONS });
    game.submitAnswer({ questionId: 'q1', answer: '3/4' });
    game.submitAnswer({ questionId: 'q2', answer: '1/3' });
    const fb = game.feedback();
    expect(fb.score).toBe(10);
    expect(fb.answered).toBe(2);
    expect(fb.totalQuestions).toBe(2);
    expect(fb.correctAnswers).toBe(1);
    expect(fb.accuracy).toBeCloseTo(0.5);
    expect(fb.completed).toBe(true);
    expect(typeof fb.message).toBe('string');
  });

  test('a perfect round gets the encouraging message', () => {
    const game = new Game({ questions: QUESTIONS });
    game.submitAnswer({ questionId: 'q1', answer: '3/4' });
    game.submitAnswer({ questionId: 'q2', answer: '1/2' });
    expect(game.feedback().message).toMatch(/Perfect/);
  });

  test('a round with no questions reports zero accuracy rather than NaN', () => {
    const game = new Game({ questions: [] });
    expect(game.feedback().accuracy).toBe(0);
    expect(game.feedback().message).toMatch(/No questions/);
  });
});

describe('Game serialisation (Redis + JSONB round-trip)', () => {
  test('toJSON/fromJSON preserve the full aggregate', () => {
    const game = new Game({ user: { id: 'u1', username: 'astro' }, questions: QUESTIONS });
    game.submitAnswer({ questionId: 'q1', answer: '3/4' });

    const restored = Game.fromJSON(JSON.parse(JSON.stringify(game.toJSON())));
    expect(restored.id).toBe(game.id);
    expect(restored.score).toBe(game.score);
    expect(restored.answers).toHaveLength(1);
    expect(restored.questions).toHaveLength(2);
    expect(restored.user.username).toBe('astro');
  });

  test('fromJSON accepts a JSON string (as JSONB columns may return)', () => {
    const game = new Game({ questions: QUESTIONS });
    expect(Game.fromJSON(JSON.stringify(game.toJSON())).id).toBe(game.id);
  });

  test('fromJSON(null) returns null', () => {
    expect(Game.fromJSON(null)).toBeNull();
  });
});
