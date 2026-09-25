'use strict';

const express = require('express');
const { oauth2 } = require('@spacefractions/shared');
const { SCOPES, ROLES } = oauth2;

/**
 * QuestionComponent HTTP surface.
 *
 * Routes map onto the diagrams:
 *   SequenceDiagram1: Question ->> Game : return prompt        -> GET  /api/v1/questions/:id
 *   SequenceDiagram1: Game ->> Question : check answer         -> POST /api/v1/questions/:id/check
 *   SequenceDiagram2: Admin ->> Question : update()            -> PUT  /api/v1/questions/:id
 *   UseCaseDiagram:   Admin -- (Update Questions)              -> POST /api/v1/questions (create)
 */
function createQuestionRoutes({ service, logger }) {
  const router = express.Router();
  const v1 = express.Router();

  // Public read of a prompt - students need this while playing.
  v1.get('/questions', oauth2.authenticate({ optional: true }), async (req, res, next) => {
    try {
      const limit = Math.min(Number.parseInt(req.query.limit || '10', 10) || 10, 100);
      const offset = Math.max(Number.parseInt(req.query.offset || '0', 10) || 0, 0);
      const difficulty = req.query.difficulty || null;
      const isAdmin = req.user && req.user.roles && req.user.roles.includes(ROLES.ADMIN);
      const result = isAdmin
        ? await service.listForAdmin({ limit, offset, difficulty })
        : await service.list({ limit, offset, difficulty });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Elasticsearch-backed search (NFR-1 performance).
  v1.get('/questions/search', async (req, res, next) => {
    try {
      const q = req.query.q;
      if (!q) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'q is required' });
      }
      res.json(await service.search(q, Math.min(Number.parseInt(req.query.size || '20', 10) || 20, 100)));
    } catch (err) {
      return next(err);
    }
  });

  // SequenceDiagram1: return prompt
  v1.get('/questions/:questionId', async (req, res, next) => {
    try {
      res.json(await service.getPrompt(req.params.questionId));
    } catch (err) {
      next(err);
    }
  });

  // SequenceDiagram1: check answer -> return result
  v1.post('/questions/:questionId/check', async (req, res, next) => {
    try {
      const { answer } = req.body || {};
      if (answer === undefined) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'answer is required' });
      }
      res.json(await service.checkAnswer(req.params.questionId, answer));
    } catch (err) {
      return next(err);
    }
  });

  // SequenceDiagram2 / UseCaseDiagram: Admin update()
  v1.post(
    '/questions',
    oauth2.authenticate({ roles: [ROLES.ADMIN], scopes: [SCOPES.UPDATE_QUESTIONS] }),
    async (req, res, next) => {
      try {
        res.status(201).json(await service.create(req.body));
      } catch (err) {
        next(err);
      }
    },
  );

  v1.put(
    '/questions/:questionId',
    oauth2.authenticate({ roles: [ROLES.ADMIN], scopes: [SCOPES.UPDATE_QUESTIONS] }),
    async (req, res, next) => {
      try {
        res.json(await service.update(req.params.questionId, req.body));
      } catch (err) {
        next(err);
      }
    },
  );

  v1.delete(
    '/questions/:questionId',
    oauth2.authenticate({ roles: [ROLES.ADMIN], scopes: [SCOPES.UPDATE_QUESTIONS] }),
    async (req, res, next) => {
      try {
        res.json(await service.remove(req.params.questionId));
      } catch (err) {
        next(err);
      }
    },
  );

  // ASR-1 durability status endpoint (operator-facing).
  v1.get('/durability', async (req, res, next) => {
    try {
      res.json(await service.durabilityStatus());
    } catch (err) {
      next(err);
    }
  });

  // Recovery / reseed path required by ASR-1 "persisted and recoverable".
  v1.post(
    '/admin/seed',
    oauth2.authenticate({ roles: [ROLES.ADMIN], scopes: [SCOPES.UPDATE_QUESTIONS] }),
    async (req, res, next) => {
      try {
        res.json(await service.seed({ force: Boolean(req.body && req.body.force) }));
      } catch (err) {
        next(err);
      }
    },
  );

  router.use('/api/v1', v1);
  router.use('/v1', v1);
  return router;
}

module.exports = { createQuestionRoutes };
