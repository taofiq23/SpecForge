'use strict';

/**
 * Jest configuration for the Space Fractions monorepo.
 *
 * All tests live in tests/ and run with no external services: every PostgreSQL,
 * Redis, RabbitMQ, Elasticsearch and QuestionComponent dependency is replaced by
 * the in-memory fakes in tests/helpers/fakes.js.
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.js'],
  collectCoverageFrom: [
    'services/*/src/**/*.js',
    'shared/src/**/*.js',
  ],
  coverageDirectory: 'coverage',
  // NFR-1: the spec sets a 250ms latency budget on request paths. Keep the whole
  // suite fast enough that a regression in that budget is noticeable here too.
  testTimeout: 15000,
  verbose: true,
};
