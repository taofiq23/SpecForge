'use strict';

const express = require('express');
const { oauth2 } = require('@spacefractions/shared');
const { ROLES } = oauth2;

/**
 * UserComponent HTTP surface.
 *
 * Section F: "Implement OAuth2 for authentication and authorization".
 * The spec does not name a provider or a token endpoint, so UserComponent hosts
 * a minimal OAuth2 authorization server at POST /oauth/token (RFC 6749,
 * form-encoded) plus a small user-management surface.
 */
function createUserRoutes({ service, logger }) {
  const router = express.Router();
  const v1 = express.Router();

  // --- RFC 6749 token endpoint ---------------------------------------------
  router.post('/oauth/token', express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      const body = { ...(req.body || {}), ...(req.query || {}) };
      const grantType = body.grant_type;

      let tokenResponse;
      if (grantType === 'password') {
        tokenResponse = await service.authenticate({
          username: body.username,
          password: body.password,
          scope: body.scope || null,
        });
      } else if (grantType === 'client_credentials') {
        tokenResponse = service.issueServiceToken({
          clientId: body.client_id,
          clientSecret: body.client_secret,
          scope: body.scope || null,
        });
      } else if (grantType === 'refresh_token') {
        tokenResponse = await service.refresh({ refreshToken: body.refresh_token });
      } else {
        return res.status(400).json({
          error: 'unsupported_grant_type',
          error_description: 'Supported grant types: password, client_credentials, refresh_token',
        });
      }

      return res.json(tokenResponse);
    } catch (err) {
      if ([400, 401, 403].includes(err.status)) {
        return res
          .status(err.status)
          .json({ error: err.code || 'invalid_grant', error_description: err.message });
      }
      return next(err);
    }
  });

  // --- User management ------------------------------------------------------
  v1.post('/users', async (req, res, next) => {
    try {
      res.status(201).json(await service.register(req.body || {}));
    } catch (err) {
      next(err);
    }
  });

  v1.get('/users/me', oauth2.authenticate(), async (req, res, next) => {
    try {
      res.json(await service.me(req.user.id));
    } catch (err) {
      next(err);
    }
  });

  v1.get('/users', oauth2.authenticate({ roles: [ROLES.ADMIN] }), async (req, res, next) => {
    try {
      const limit = Math.min(Number.parseInt(req.query.limit || '50', 10) || 50, 200);
      const offset = Math.max(Number.parseInt(req.query.offset || '0', 10) || 0, 0);
      res.json(await service.list({ limit, offset }));
    } catch (err) {
      next(err);
    }
  });

  // Authorization decision used by GameComponent to enforce the UseCaseDiagram.
  v1.get('/authorize', oauth2.authenticate(), async (req, res, next) => {
    try {
      const scope = req.query.scope;
      if (!scope) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'scope is required' });
      }
      return res.json(await service.authorise(req.user.id, scope));
    } catch (err) {
      return next(err);
    }
  });

  // Static view of the role -> scope mapping so clients can discover it.
  v1.get('/scopes', (req, res) => {
    res.json({ roles: oauth2.ROLE_SCOPES, scopes: oauth2.SCOPES });
  });

  // Echo of the verified token - proves OAuth2 verification works end to end.
  v1.get('/introspect', oauth2.authenticate(), (req, res) => {
    res.json({
      active: true,
      sub: req.user.id,
      username: req.user.username,
      roles: req.user.roles,
      scopes: req.user.scopes,
      issuer: req.user.claims && req.user.claims.iss,
    });
  });

  router.use('/api/v1', v1);
  router.use('/v1', v1);
  return router;
}

module.exports = { createUserRoutes };
