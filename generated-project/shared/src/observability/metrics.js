'use strict';

const client = require('prom-client');
const config = require('../config');

/**
 * Prometheus instrumentation (spec section D: "Observability: Prometheus 2-3").
 *
 * Section G names the metrics we must surface:
 *   - GameComponent:     game start rate, game completion rate, user engagement
 *   - QuestionComponent: question response rate, question accuracy rate
 * Section G also names an SLO of 99.99% uptime with a 1% error budget.
 */
function createMetrics(componentName) {
  const registry = new client.Registry();
  registry.setDefaultLabels({
    ...config.prometheus.defaultLabels,
    component: componentName,
  });

  client.collectDefaultMetrics({ register: registry, prefix: 'spacefractions_' });

  // --- NFR-1 (performance): latency + throughput per route ---
  const httpRequestDuration = new client.Histogram({
    name: 'spacefractions_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry],
  });

  const httpRequestsTotal = new client.Counter({
    name: 'spacefractions_http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status_code'],
    registers: [registry],
  });

  const httpErrorsTotal = new client.Counter({
    name: 'spacefractions_http_errors_total',
    help: 'Total number of HTTP error responses (status >= 500)',
    labelNames: ['method', 'route'],
    registers: [registry],
  });

  // --- Section G business metrics ---
  const gamesStarted = new client.Counter({
    name: 'spacefractions_games_started_total',
    help: 'GameComponent: game start rate',
    labelNames: ['mode'],
    registers: [registry],
  });

  const gamesCompleted = new client.Counter({
    name: 'spacefractions_games_completed_total',
    help: 'GameComponent: game completion rate',
    labelNames: ['outcome'],
    registers: [registry],
  });

  const questionsAnswered = new client.Counter({
    name: 'spacefractions_questions_answered_total',
    help: 'QuestionComponent: question response rate',
    labelNames: ['correct'],
    registers: [registry],
  });

  const answerAccuracy = new client.Gauge({
    name: 'spacefractions_question_accuracy_ratio',
    help: 'QuestionComponent: rolling question accuracy rate',
    registers: [registry],
  });

  const userEngagementSeconds = new client.Histogram({
    name: 'spacefractions_user_engagement_seconds',
    help: 'GameComponent: user engagement (session duration)',
    labelNames: ['completed'],
    buckets: [30, 60, 120, 300, 600, 1800, 3600],
    registers: [registry],
  });

  const externalCallDuration = new client.Histogram({
    name: 'spacefractions_external_call_duration_seconds',
    help: 'Duration of calls to external systems (postgres, redis, rabbitmq, elasticsearch)',
    labelNames: ['system', 'operation', 'result'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 3],
    registers: [registry],
  });

  /** Track answer outcomes so the accuracy gauge can be updated. */
  let answersTotal = 0;
  let answersCorrect = 0;

  function recordAnswer(correct) {
    answersTotal += 1;
    if (correct) answersCorrect += 1;
    questionsAnswered.inc({ correct: String(Boolean(correct)) });
    answerAccuracy.set(answersTotal === 0 ? 0 : answersCorrect / answersTotal);
  }

  function timeExternal(system, operation, fn) {
    const end = externalCallDuration.startTimer({ system, operation });
    return Promise.resolve()
      .then(fn)
      .then((result) => {
        end({ result: 'success' });
        return result;
      })
      .catch((err) => {
        end({ result: 'error' });
        throw err;
      });
  }

  return {
    registry,
    client,
    httpRequestDuration,
    httpRequestsTotal,
    httpErrorsTotal,
    gamesStarted,
    gamesCompleted,
    questionsAnswered,
    accuracyGauge: answerAccuracy,
    userEngagementSeconds,
    externalCallDuration,
    recordAnswer,
    timeExternal,
    async metrics() {
      return registry.metrics();
    },
    contentType: registry.contentType,
  };
}

module.exports = { createMetrics };
