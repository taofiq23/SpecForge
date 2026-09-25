'use strict';

const express = require('express');
const { oauth2 } = require('@spacefractions/shared');
const { ROLES, SCOPES } = oauth2;
const { AdminService } = require('../service/adminService');

/**
 * Base path AdminComponent is mounted under.
 *
 * The DeploymentDiagram (spec.json view 10) draws AdminClient as a *separate*
 * node wired `GameServer -- AdminClient`, and previously AdminClient called the
 * GameServer. In the browser the game and the admin screen are same-origin when
 * served by GameComponent, so `/api/v1/admin` remains the documented path and
 * is used unchanged by both the old curl examples and the new admin screen.
 */
const ADMIN_BASE_PATH = '/api/v1/admin';

/**
 * AdminComponent HTTP surface (spec.json view 9, ComponentDiagram):
 *
 *   artifact AdminComponent
 *   GameComponent -- AdminComponent
 *
 * UseCaseDiagram:  Admin -- (Update Questions)
 * SequenceDiagram2: Admin ->> Question : update(); Question ->> Admin : return success
 *
 * The whole router is gated on an admin bearer token carrying the
 * `update_questions` scope, so the UseCaseDiagram's actor association is
 * enforced in code, not merely documented.
 */
function createAdminRoutes({ adminService, service, questionClient, logger } = {}) {
  // Accept the older call shape ({ service, questionClient }) as well as the
  // real one ({ adminService }), so the pre-existing GameComponent wiring and
  // the test suite keep working while AdminComponent is the real implementation.
  const resolved =
    adminService ||
    (service && service.adminService) ||
    new AdminService({
      questionClient: questionClient || (service && service.questionClient) || null,
      gameService: service || null,
      logger,
    });

  const router = express.Router();

  router.use(oauth2.authenticate({ roles: [ROLES.ADMIN], scopes: [SCOPES.UPDATE_QUESTIONS] }));

  // --- Question management (UseCaseDiagram: Update Questions) ---------------

  // Admin view of the bank, *with* answer keys (students never get these).
  router.get('/questions', async (req, res, next) => {
    try {
      const limit = Math.min(Number.parseInt(req.query.limit || '50', 10) || 50, 200);
      const offset = Math.max(Number.parseInt(req.query.offset || '0', 10) || 0, 0);
      const difficulty = req.query.difficulty || null;
      res.json(
        await resolved.listQuestions({ limit, offset, difficulty }, req.headers.authorization),
      );
    } catch (err) {
      next(err);
    }
  });

  router.get('/questions/search', async (req, res, next) => {
    try {
      const q = req.query.q;
      if (!q) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'q is required' });
      }
      res.json(await resolved.searchQuestions(q, Math.min(Number.parseInt(req.query.size || '20', 10) || 20, 100)));
    } catch (err) {
      return next(err);
    }
  });

  router.get('/questions/:questionId', async (req, res, next) => {
    try {
      res.json(await resolved.getQuestion(req.params.questionId));
    } catch (err) {
      next(err);
    }
  });

  router.post('/questions', async (req, res, next) => {
    try {
      const created = await resolved.createQuestion(req.body, req.headers.authorization);
      const body = created && created.proxied
        ? { ...created.body, proxied: true, path: created.path, method: created.method }
        : created;
      res.status(201).json(body);
    } catch (err) {
      next(err);
    }
  });

  // SequenceDiagram2 Admin "update()"
  router.put('/questions/:questionId', async (req, res, next) => {
    try {
      res.json(
        await resolved.updateQuestion(req.params.questionId, req.body, req.headers.authorization),
      );
    } catch (err) {
      next(err);
    }
  });

  router.delete('/questions/:questionId', async (req, res, next) => {
    try {
      res.json(await resolved.deactivateQuestion(req.params.questionId, req.headers.authorization));
    } catch (err) {
      next(err);
    }
  });

  // --- Game statistics (section G business metrics) -------------------------

  router.get('/games/stats', async (req, res, next) => {
    try {
      res.json(await resolved.gameStats());
    } catch (err) {
      next(err);
    }
  });

  // Who am I - the admin screen uses this to prove the token it holds is really
  // an admin token before showing the editor.
  router.get('/whoami', (req, res) => {
    res.json({
      component: 'AdminComponent',
      id: req.user.id,
      username: req.user.username,
      roles: req.user.roles,
      scopes: req.user.scopes,
    });
  });

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    logger && logger.warn({ err: err.message }, 'admin route error');
    res
      .status(err.status || 500)
      .json({ error: err.code || 'internal_error', error_description: err.message });
  });

  return router;
}

module.exports = { createAdminRoutes, ADMIN_BASE_PATH };
