'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

/**
 * Shared Express app factory (spec section D: "Web framework: Express.js 4-5").
 *
 * Provides:
 *   - helmet  (ASR-2 security: secure headers, plus TLS terminated upstream)
 *   - cors    (the web client in "UserClient" / "AdminClient" is a browser)
 *   - /health liveness,  /ready readiness (k8s probes in section E)
 *   - /metrics Prometheus scrape endpoint
 *   - latency instrumentation for the NFR-1 budget
 */
function createApp({
  componentName,
  logger,
  metrics,
  readyChecks = [],
  openApiDocument = null,
  // Component routers are mounted through this hook, BEFORE the terminal 404 and
  // error handlers below. Mounting them with app.use() after createApp() returns
  // would put them behind the catch-all 404 and make every route unreachable.
  mountRoutes = null,
}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: false }));
  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '256kb' }));

  // Correlation id so a single play session can be traced across components.
  app.use((req, res, next) => {
    const correlationId =
      req.headers['x-correlation-id'] ||
      req.headers['x-request-id'] ||
      `${componentName.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    req.correlationId = correlationId;
    res.setHeader('x-correlation-id', correlationId);
    next();
  });

  // NFR-1 instrumentation on every request.
  app.use((req, res, next) => {
    if (!metrics) return next();
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const route = req.route ? req.baseUrl + req.route.path : req.path;
      const labels = { method: req.method, route, status_code: String(res.statusCode) };
      metrics.httpRequestDuration.observe(labels, seconds);
      metrics.httpRequestsTotal.inc(labels);
      if (res.statusCode >= 500) metrics.httpErrorsTotal.inc({ method: req.method, route });
      if (logger) {
        logger.info(
          {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs: Math.round(seconds * 1000),
            correlationId: req.correlationId,
          },
          'request completed',
        );
      }
    });
    return next();
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'UP', component: componentName, timestamp: new Date().toISOString() });
  });

  app.get('/ready', async (req, res) => {
    const results = await Promise.all(
      readyChecks.map(async (check) => {
        try {
          const ok = await check.check();
          return { name: check.name, ok: Boolean(ok) };
        } catch (err) {
          return { name: check.name, ok: false, error: err.message };
        }
      }),
    );
    // Only hard dependencies are required for readiness; caches/search degrade.
    const required = readyChecks.filter((c) => c.required !== false).map((c) => c.name);
    const ready = results.filter((r) => required.includes(r.name)).every((r) => r.ok);
    res.status(ready ? 200 : 503).json({
      status: ready ? 'READY' : 'NOT_READY',
      component: componentName,
      checks: results,
    });
  });

  if (metrics) {
    app.get('/metrics', async (req, res) => {
      res.set('Content-Type', metrics.contentType);
      res.send(await metrics.metrics());
    });
  }

  if (openApiDocument) {
    app.get('/openapi.json', (req, res) => res.json(openApiDocument));
  }

  // Component routes go here - before the 404 catch-all.
  if (typeof mountRoutes === 'function') {
    mountRoutes(app);
  }

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', error_description: `No route for ${req.method} ${req.path}` });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (logger) logger.error({ err: err.message, stack: err.stack }, 'unhandled error');
    const status = err.status || err.statusCode || 500;
    res.status(status).json({
      error: err.code || (status >= 500 ? 'internal_error' : 'bad_request'),
      error_description: err.message,
    });
  });

  return app;
}

module.exports = { createApp };
