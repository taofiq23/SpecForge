'use strict';

/**
 * Canonical Space Fractions question bank.
 *
 * The spec never gives question content - it only says the system "consists of
 * ... a series of fraction questions". This module is the single source of the
 * built-in set, shared by QuestionComponent (seeding / ASR-1 recovery) and
 * GameComponent (offline fallback when QuestionComponent is unreachable).
 */
const FRACTION_QUESTIONS = Object.freeze([
  { prompt: 'What is 1/2 + 1/4?', options: ['2/6', '3/4', '1/6', '2/4'], correctOption: '3/4', difficulty: 'easy' },
  { prompt: 'What is 2/3 - 1/6?', options: ['1/3', '1/2', '1/6', '3/6'], correctOption: '1/2', difficulty: 'easy' },
  { prompt: 'Which fraction is largest?', options: ['2/3', '3/5', '5/8', '1/2'], correctOption: '2/3', difficulty: 'easy' },
  { prompt: 'Simplify 18/24.', options: ['2/3', '3/4', '6/8', '9/12'], correctOption: '3/4', difficulty: 'easy' },
  { prompt: 'What is 3/5 x 10/9?', options: ['2/3', '30/45', '13/14', '1/2'], correctOption: '2/3', difficulty: 'medium' },
  { prompt: 'What is 4/7 divided by 2/7?', options: ['2', '8/49', '1/2', '6/7'], correctOption: '2', difficulty: 'medium' },
  { prompt: 'What is 5/6 + 1/3?', options: ['6/9', '7/6', '1 1/6', '2/3'], correctOption: '1 1/6', difficulty: 'medium' },
  { prompt: 'What is 7/8 - 1/4?', options: ['5/8', '6/8', '1/2', '3/4'], correctOption: '5/8', difficulty: 'medium' },
  { prompt: 'Which is equivalent to 2/5?', options: ['4/10', '3/8', '2/10', '5/2'], correctOption: '4/10', difficulty: 'medium' },
  { prompt: 'What is 1/3 of 3/4?', options: ['1/4', '3/12', '1/12', '4/3'], correctOption: '1/4', difficulty: 'medium' },
  {
    prompt: 'A tank is 3/8 full. After adding 1/4 of its capacity, how full is it?',
    options: ['5/8', '4/12', '1/2', '7/8'],
    correctOption: '5/8',
    difficulty: 'hard',
  },
  {
    prompt: 'What is 9/10 - 2/5?',
    options: ['1/2', '7/5', '5/10', '7/10'],
    correctOption: '1/2',
    difficulty: 'hard',
  },
  {
    prompt: 'Divide 5/6 by 5/12.',
    options: ['2', '25/72', '1/2', '5/6'],
    correctOption: '2',
    difficulty: 'hard',
  },
  {
    prompt: 'Which is the smallest: 7/8, 5/6, 11/12, 3/4?',
    options: ['3/4', '5/6', '7/8', '11/12'],
    correctOption: '3/4',
    difficulty: 'hard',
  },
  {
    prompt: 'A rocket travels 2/3 of a kilometre, then 3/4 more. Total distance?',
    options: ['1 5/12', '5/7', '1 1/12', '6/7'],
    correctOption: '1 5/12',
    difficulty: 'hard',
  },
]);

/** Build `count` questions with stable ids, cycling through the bank. */
function buildDefaultQuestionSet(count = 10) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const q = FRACTION_QUESTIONS[i % FRACTION_QUESTIONS.length];
    out.push({
      id: `builtin-${i + 1}`,
      prompt: q.prompt,
      options: q.options.slice(),
      correctOption: q.correctOption,
      difficulty: q.difficulty,
      weight: q.difficulty === 'hard' ? 2 : q.difficulty === 'medium' ? 1.5 : 1,
      tags: ['fractions', q.difficulty],
    });
  }
  return out;
}

module.exports = { FRACTION_QUESTIONS, buildDefaultQuestionSet };
