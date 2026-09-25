'use strict';

/**
 * QuestionComponent tests.
 *
 * Covers:
 *   - `Question`, the ClassDiagram class (view 2): getPrompt(), getOptions()
 *   - SequenceDiagram1's "check answer" / "return result" (grading)
 *   - SequenceDiagram2's "Admin ->> Question: update()"
 *   - ASR-1 (data durability): question data is persisted and recoverable
 */
const { Question } = require('../../services/question/src/domain/question');
const { QuestionService } = require('../../services/question/src/service/questionService');
const { QuestionRepository } = require('../../services/question/src/repository/questionRepository');
const { buildDefaultQuestionSet } = require('../../services/question/src/service/seedQuestions');
const config = require('../../shared/src/config');
const {
  FakePgPool,
  FakeRedisClient,
  createFakeCache,
  createFakeMessaging,
  createFakeSearch,
} = require('../helpers/fakes');

const silentLogger = { info() {}, debug() {}, warn() {}, error() {} };

describe('Question (ClassDiagram: class Question)', () => {
  test('getPrompt() and getOptions() match the diagram signatures', () => {
    const q = new Question({ prompt: 'What is 1/2 + 1/4?', options: ['2/6', '3/4'], correctOption: '3/4' });
    expect(q.getPrompt()).toBe('What is 1/2 + 1/4?');
    expect(q.getOptions()).toEqual(['2/6', '3/4']);
    expect(typeof q.id).toBe('string');
  });

  test('getOptions() returns a copy, so callers cannot mutate the aggregate', () => {
    const q = new Question({ prompt: 'p?', options: ['a', 'b'], correctOption: 'a' });
    q.getOptions().push('c');
    expect(q.options).toEqual(['a', 'b']);
  });

  test('defaults difficulty to medium and weight to 1', () => {
    const q = new Question({ prompt: 'p?', options: ['a', 'b'], correctOption: 'a' });
    expect(q.difficulty).toBe('medium');
    expect(q.weight).toBe(1);
  });
});

describe('Question.checkAnswer (SequenceDiagram1: check answer -> return result)', () => {
  const q = new Question({ prompt: 'What is 1/2 + 1/4?', options: ['2/6', '3/4'], correctOption: '3/4' });

  test('an exact match is correct', () => {
    expect(q.checkAnswer('3/4')).toMatchObject({ correct: true, reason: 'exact_match' });
  });

  test('whitespace is ignored', () => {
    expect(q.checkAnswer('  3/4 ').correct).toBe(true);
  });

  test('an equivalent fraction is accepted (a learning tool must not mark maths wrong)', () => {
    const half = new Question({ prompt: 'Simplify 2/4', options: ['1/2', '2/4'], correctOption: '1/2' });
    expect(half.checkAnswer('2/4')).toMatchObject({ correct: true, reason: 'equivalent_fraction' });
  });

  test('a wrong answer returns the correct option for feedback', () => {
    expect(q.checkAnswer('2/6')).toMatchObject({ correct: false, reason: 'mismatch', correctOption: '3/4' });
  });

  test('a null/undefined answer is reported as empty rather than throwing', () => {
    expect(q.checkAnswer(null)).toMatchObject({ correct: false, reason: 'empty_answer' });
    expect(q.checkAnswer(undefined)).toMatchObject({ correct: false, reason: 'empty_answer' });
  });
});

describe('Question.validate (admin authoring rules)', () => {
  test('a well-formed question passes', () => {
    const q = new Question({ prompt: 'What is 1/2?', options: ['1/2', '1/3'], correctOption: '1/2' });
    expect(q.validate()).toEqual({ valid: true, errors: [] });
  });

  test('rejects a too-short prompt', () => {
    const q = new Question({ prompt: 'x', options: ['a', 'b'], correctOption: 'a' });
    expect(q.validate().errors).toContain('prompt must be a string of at least 3 characters');
  });

  test('rejects fewer than two options', () => {
    const q = new Question({ prompt: 'What is 1/2?', options: ['a'], correctOption: 'a' });
    expect(q.validate().errors.join()).toMatch(/at least 2 entries/);
  });

  test('rejects an answer key that is not one of the options', () => {
    const q = new Question({ prompt: 'What is 1/2?', options: ['a', 'b'], correctOption: 'z' });
    expect(q.validate().errors).toContain('correctOption must be one of the options');
  });

  test('rejects an unknown difficulty', () => {
    const q = new Question({ prompt: 'What is 1/2?', options: ['a', 'b'], correctOption: 'a', difficulty: 'impossible' });
    expect(q.validate().errors.join()).toMatch(/easy, medium, hard/);
  });
});

describe('Question projections', () => {
  test('toPublicJSON omits the answer key (students must not receive it)', () => {
    const q = new Question({ prompt: 'What is 1/2 + 1/4?', options: ['2/6', '3/4'], correctOption: '3/4' });
    expect(q.toPublicJSON()).not.toHaveProperty('correctOption');
    expect(q.toPublicJSON().prompt).toBe('What is 1/2 + 1/4?');
  });

  test('toJSON round-trips through the domain object', () => {
    const q = new Question({ prompt: 'What is 1/2 + 1/4?', options: ['2/6', '3/4'], correctOption: '3/4' });
    expect(Question.fromJSON(JSON.parse(JSON.stringify(q.toJSON()))).correctOption).toBe('3/4');
  });
});

describe('seedQuestions default bank', () => {
  test('builds the requested number of questions with valid shape', () => {
    const set = buildDefaultQuestionSet(8);
    expect(set).toHaveLength(8);
    set.forEach((q) => {
      expect(q.prompt.length).toBeGreaterThan(3);
      expect(q.options.length).toBeGreaterThanOrEqual(2);
      expect(q.options).toContain(q.correctOption);
      expect(['easy', 'medium', 'hard']).toContain(q.difficulty);
    });
  });

  test('every seeded question validates', () => {
    buildDefaultQuestionSet(20).forEach((raw) => {
      expect(new Question(raw).validate().valid).toBe(true);
    });
  });

  test('difficulty and weight come from the canonical bank entry', () => {
    const set = buildDefaultQuestionSet(15);
    // The bank is ordered easy -> medium -> hard, so a full cycle covers all three.
    expect(set[0].difficulty).toBe('easy');
    expect(set[4].difficulty).toBe('medium');
    expect(set[10].difficulty).toBe('hard');

    // Weight is derived from difficulty (10 * weight is the scoring rule).
    expect(set[0].weight).toBe(1);
    expect(set[4].weight).toBe(1.5);
    expect(set[10].weight).toBe(2);
  });

  test('ids are stable so re-seeding after a restore is idempotent', () => {
    const first = buildDefaultQuestionSet(5).map((q) => q.id);
    const second = buildDefaultQuestionSet(5).map((q) => q.id);
    expect(first).toEqual(second);
  });

  test('the bank cycles when more questions are requested than it holds', () => {
    const set = buildDefaultQuestionSet(20);
    expect(set).toHaveLength(20);
    expect(set[15].prompt).toBe(set[0].prompt);
    expect(set[15].id).not.toBe(set[0].id);
  });
});

function build() {
  const pool = new FakePgPool();
  const redis = new FakeRedisClient();
  const cache = createFakeCache(redis);
  const messaging = createFakeMessaging();
  const search = createFakeSearch();
  const repository = new QuestionRepository({ pool, cache, search, logger: silentLogger, schema: 'question' });
  const service = new QuestionService({ repository, messaging, metrics: null, logger: silentLogger, config });
  return { pool, redis, cache, messaging, search, repository, service };
}

describe('QuestionService CRUD (SequenceDiagram2: Admin ->> Question: update())', () => {
  test('create() persists and publishes question.updated', async () => {
    const { service, pool, messaging } = build();
    const created = await service.create({
      prompt: 'What is 1/3 + 1/3?', options: ['2/3', '1/6'], correctOption: '2/3', difficulty: 'easy',
    });

    expect(created.prompt).toBe('What is 1/3 + 1/3?');
    expect(pool.questions).toHaveLength(1);
    expect(messaging.events(config.rabbitmq.events.questionUpdated)).toHaveLength(1);
    expect(messaging.events(config.rabbitmq.events.questionUpdated)[0].payload.action).toBe('created');
  });

  test('create() rejects an invalid question with a 400', async () => {
    const { service } = build();
    await expect(service.create({ prompt: 'x', options: ['a'], correctOption: 'a' })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_question',
    });
  });

  test('update() returns the merged, re-validated question', async () => {
    const { service } = build();
    const created = await service.create({
      prompt: 'What is 1/3 + 1/3?', options: ['2/3', '1/6'], correctOption: '2/3',
    });
    const updated = await service.update(created.id, { prompt: 'What is 1/4 + 1/4?' });
    expect(updated.prompt).toBe('What is 1/4 + 1/4?');
  });

  test('update() on an unknown question is a 404', async () => {
    const { service } = build();
    await expect(service.update('nope', { prompt: 'What is 1/2?' })).rejects.toMatchObject({
      status: 404,
      code: 'question_not_found',
    });
  });

  test('remove() soft-deletes so history stays durable', async () => {
    const { service, pool } = build();
    const created = await service.create({
      prompt: 'What is 1/3 + 1/3?', options: ['2/3', '1/6'], correctOption: '2/3',
    });
    const removed = await service.remove(created.id);
    expect(removed.active).toBe(false);
    // Row is still present: deactivation, not deletion (ASR-1).
    expect(pool.questions).toHaveLength(1);
    expect(pool.questions[0].active).toBe(false);
  });

  test('remove() on an unknown question is a 404', async () => {
    const { service } = build();
    await expect(service.remove('nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('QuestionService read paths', () => {
  test('getPrompt() returns the public projection without the answer key', async () => {
    const { service } = build();
    const created = await service.create({
      prompt: 'What is 1/3 + 1/3?', options: ['2/3', '1/6'], correctOption: '2/3',
    });
    const prompt = await service.getPrompt(created.id);
    expect(prompt.prompt).toBe('What is 1/3 + 1/3?');
    expect(prompt).not.toHaveProperty('correctOption');
  });

  test('getPrompt() on an unknown question is a 404', async () => {
    const { service } = build();
    await expect(service.getPrompt('nope')).rejects.toMatchObject({ status: 404 });
  });

  test('checkAnswer() grades and publishes the outcome without leaking the answer', async () => {
    const { service, messaging } = build();
    const created = await service.create({
      prompt: 'What is 1/3 + 1/3?', options: ['2/3', '1/6'], correctOption: '2/3',
    });
    const result = await service.checkAnswer(created.id, '2/3');

    expect(result.correct).toBe(true);
    expect(result.questionId).toBe(created.id);
    const published = messaging.events(config.rabbitmq.events.answerSubmitted)[0].payload;
    expect(published.correct).toBe(true);
    // Privacy/security: the submitted free-text answer is not forwarded.
    expect(published).not.toHaveProperty('answer');
  });

  test('checkAnswer() on an unknown question is a 404', async () => {
    const { service } = build();
    await expect(service.checkAnswer('nope', '2/3')).rejects.toMatchObject({ status: 404 });
  });

  test('list() paginates and never exposes answer keys', async () => {
    const { service } = build();
    await service.create({ prompt: 'What is 1/3 + 1/3?', options: ['2/3', '1/6'], correctOption: '2/3' });
    await service.create({ prompt: 'What is 1/5 + 1/5?', options: ['2/5', '1/10'], correctOption: '2/5' });

    const page = await service.list({ limit: 1, offset: 0 });
    expect(page.questions).toHaveLength(1);
    expect(page.limit).toBe(1);
    expect(page.offset).toBe(0);
    expect(page.questions[0]).not.toHaveProperty('correctOption');
  });

  test('listForAdmin() includes the answer key for the admin actor', async () => {
    const { service } = build();
    await service.create({ prompt: 'What is 1/3 + 1/3?', options: ['2/3', '1/6'], correctOption: '2/3' });
    const adminPage = await service.listForAdmin({ limit: 10 });
    expect(adminPage.questions[0]).toHaveProperty('correctOption');
  });

  test('search() delegates to Elasticsearch (NFR-1)', async () => {
    const { service, search } = build();
    await search.indexDocument('q1', { prompt: 'What is 1/3 + 1/3?' });
    await search.indexDocument('q2', { prompt: 'What is 2/5 + 1/5?' });

    const result = await service.search('1/3');
    expect(result.engine).toBe('elasticsearch');
    expect(result.total).toBe(1);
    expect(result.results[0].prompt).toBe('What is 1/3 + 1/3?');
  });
});

describe('ASR-1: question data durability and recoverability', () => {
  test('durabilityStatus() reports replication, recovery point and RPO/RTO', async () => {
    const { service } = build();
    await service.create({ prompt: 'What is 1/3 + 1/3?', options: ['2/3', '1/6'], correctOption: '2/3' });

    const status = await service.durabilityStatus();
    expect(status.component).toBe('QuestionComponent');
    expect(status.requirement).toBe('ASR-1');
    expect(status.persistedQuestions).toBe(1);
    expect(status.replication).toHaveProperty('standbys');
    expect(status.replication).toHaveProperty('healthy');
    expect(status.recoveryPoint).toHaveProperty('wal_lsn');
    // Section G: RTO 1 hour, RPO 1 hour.
    expect(status.rpoTargetHours).toBe(1);
    expect(status.rtoTargetHours).toBe(1);
  });

  test('seed() populates an empty bank', async () => {
    const { service, pool } = build();
    const result = await service.seed();
    expect(result.skipped).toBe(false);
    expect(result.seeded).toBeGreaterThan(0);
    expect(pool.questions.length).toBe(result.seeded);
  });

  test('seed() is idempotent: a second call is skipped unless forced', async () => {
    const { service } = build();
    await service.seed();
    const second = await service.seed();
    expect(second.skipped).toBe(true);
    expect(second.seeded).toBe(0);
  });

  test('seed() repopulates after a restore (recoverability)', async () => {
    const { service, pool } = build();
    await service.seed();
    // Simulate a restore that lost everything.
    pool.questions = [];
    const recovered = await service.seed();
    expect(recovered.seeded).toBeGreaterThan(0);
    expect(pool.questions.length).toBeGreaterThan(0);
  });

  test('seeded questions are indexed in Elasticsearch', async () => {
    const { service, search } = build();
    await service.seed();
    expect(search.indexed.size).toBeGreaterThan(0);
  });

  test('gets and reads survive a cold cache by falling back to PostgreSQL', async () => {
    const { service, repository, cache } = build();
    const created = await service.create({
      prompt: 'What is 1/3 + 1/3?', options: ['2/3', '1/6'], correctOption: '2/3',
    });
    await cache.del(`question:${created.id}`);

    const loaded = await repository.findById(created.id);
    expect(loaded.prompt).toBe('What is 1/3 + 1/3?');
  });
});
