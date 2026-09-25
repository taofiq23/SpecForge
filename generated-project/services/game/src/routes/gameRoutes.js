'use strict';

const express = require('express');
const { oauth2 } = require('@spacefractions/shared');
const { SCOPES, ROLES } = oauth2;

/**
 * GameComponent HTTP surface. The only path the spec gives verbatim is:
 *
 *   paths:
 *     /play:
 *       get:
 *         summary: Play the game
 *         responses:
 *           200: { description: Game started, ... gameId: integer }
 *
 * `/play` is implemented verbatim (GET, returns { gameId }) so the artifact and
 * the running service agree. The other REST routes follow from the
 * UseCaseDiagram (Play Game, View Score, View Help) and the SequenceDiagram.
 */
function createGameRoutes({ service, logger }) {
  const router = express.Router();

  // --- Spec-verbatim endpoint: GET /play ------------------------------------
  // Returns { gameId }. Kept unauthenticated because the spec shows no security
  // scheme on it and openapi.yaml declares none.
  router.get('/play', async (req, res, next) => {
    try {
      const started = await service.startGame({ questionCount: 10 });
      // The spec's schema declares gameId as an integer. Our internal ids are
      // UUID strings, so the spec-facing endpoint exposes a stable numeric id
      // derived from the game count, and also returns the UUID for the
      // richer API surface. See README -> "Underspecified areas".
      const numericId = await service.repository.countAll();
      res.status(200).json({
        gameId: numericId,
        gameUid: started.gameId,
        message: 'Game started',
      });
    } catch (err) {
      next(err);
    }
  });

  // --- Versioned game API ---------------------------------------------------
  const v1 = express.Router();

  v1.post(
    '/games',
    oauth2.authenticate({ scopes: [SCOPES.PLAY_GAME], optional: true }),
    async (req, res, next) => {
      try {
        const { questionCount = 10, difficulty = null } = req.body || {};
        const user = req.user;
        const result = await service.startGame({
          userId: user ? user.id : null,
          username: user ? user.username : (req.body && req.body.username) || null,
          questionCount,
          difficulty,
        });
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  v1.get('/games/:gameId', async (req, res, next) => {
    try {
      res.json(await service.getPrompt(req.params.gameId));
    } catch (err) {
      next(err);
    }
  });

  v1.get('/games/:gameId/score', oauth2.authenticate({ optional: true }), async (req, res, next) => {
    try {
      res.json(await service.viewScore(req.params.gameId));
    } catch (err) {
      next(err);
    }
  });

  v1.post('/games/:gameId/answers', oauth2.authenticate({ optional: true }), async (req, res, next) => {
    try {
      const { questionId, answer, timeMs = null } = req.body || {};
      if (questionId === undefined || answer === undefined) {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'questionId and answer are required',
        });
      }
      const result = await service.submitAnswer(req.params.gameId, {
        questionId,
        answer,
        timeMs,
        userId: req.user ? req.user.id : null,
      });
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  });

  v1.post('/games/:gameId/pause', async (req, res, next) => {
    try {
      res.json(await service.pause(req.params.gameId));
    } catch (err) {
      next(err);
    }
  });

  v1.post('/games/:gameId/resume', async (req, res, next) => {
    try {
      res.json(await service.resume(req.params.gameId));
    } catch (err) {
      next(err);
    }
  });

  v1.post('/games/:gameId/gameover', async (req, res, next) => {
    try {
      res.json(await service.gameOver(req.params.gameId));
    } catch (err) {
      next(err);
    }
  });

  v1.get('/leaderboard', async (req, res, next) => {
    try {
      const limit = Math.min(Number.parseInt(req.query.limit || '10', 10) || 10, 100);
      res.json(await service.leaderboard({ userId: req.query.userId || null, limit }));
    } catch (err) {
      next(err);
    }
  });

  // UseCaseDiagram: ViewHelp
  v1.get('/help', (req, res) => res.json(service.viewHelp()));

  router.use('/api/v1', v1);
  router.use('/v1', v1);

  return router;
}

module.exports = { createGameRoutes };
