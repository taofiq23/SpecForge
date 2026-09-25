'use strict';

const pino = require('pino');
const config = require('./config');

/**
 * Structured logger shared by all components. Kept intentionally small - the
 * spec names Prometheus for metrics but says nothing about logging, so this is
 * one of the gaps filled in (see README).
 */
function createLogger(componentName) {
  const logger = pino({
    name: componentName,
    level: process.env.LOG_LEVEL || (config.env === 'test' ? 'silent' : 'info'),
    base: { component: componentName },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  return logger;
}

module.exports = { createLogger };
