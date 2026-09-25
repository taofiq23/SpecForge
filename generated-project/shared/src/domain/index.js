'use strict';

const crypto = require('crypto');

/**
 * Domain primitives shared across components.
 *
 * These mirror the ClassDiagram in spec.json (view "ClassDiagram"):
 *
 *   class Game     { -id: string; -score: int; +play(): void; +viewScore(): int }
 *   class Question { -id: string; -prompt: string; -options: List<string>;
 *                    +getPrompt(): string; +getOptions(): List<string> }
 *   class User     { -id: string; -username: string;
 *                    +playGame(game: Game): void; +viewScore(game: Game): int }
 *   class Admin    { -id: string; -username: string;
 *                    +updateQuestions(questions: List<Question>): void }
 *
 * The StateDiagram drives the state machine:
 *   [*] --> Playing; Playing --> Paused : pause(); Paused --> Playing : resume();
 *   Playing --> GameOver : gameOver()
 */

const GAME_STATES = Object.freeze({
  PLAYING: 'Playing',
  PAUSED: 'Paused',
  GAME_OVER: 'GameOver',
});
const ALL_GAME_STATES = Object.values(GAME_STATES);

/** The UseCaseDiagram's use cases, used for authorization + traceability. */
const USE_CASES = Object.freeze({
  PLAY_GAME: 'PlayGame',
  VIEW_SCORE: 'ViewScore',
  UPDATE_QUESTIONS: 'UpdateQuestions',
  VIEW_HELP: 'ViewHelp',
});

function newId() {
  return crypto.randomUUID();
}

/** Fraction helper: build a question whose options are fractions. */
function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    [x, y] = [y, x % y];
  }
  return x || 1;
}

function simplify(numerator, denominator) {
  const g = gcd(numerator, denominator);
  return [numerator / g, denominator / g];
}

function fractionEquals(a, b) {
  const [an, ad] = String(a).split('/').map(Number);
  const [bn, bd] = String(b).split('/').map(Number);
  if ([an, ad, bn, bd].some(Number.isNaN) || ad === 0 || bd === 0) return false;
  return an * bd === bn * ad;
}

module.exports = {
  GAME_STATES,
  ALL_GAME_STATES,
  USE_CASES,
  newId,
  gcd,
  simplify,
  fractionEquals,
};
