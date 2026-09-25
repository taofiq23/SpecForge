'use strict';

const path = require('path');
const express = require('express');
const shared = require('@spacefractions/shared');

/**
 * UserClient / AdminClient static hosting (+ the one proxy they need).
 *
 * The architecture spec's executive summary (section A) describes a game with
 * "an introductory movie, a main menu, a series of fraction questions, and an
 * ending scene with feedback", and the DeploymentDiagram (spec.json view 10)
 * names two UI nodes:
 *
 *   node GameServer
 *   node QuestionServer
 *   node UserClient
 *   node AdminClient
 *   GameServer -- UserClient
 *   GameServer -- AdminClient
 *
 * The spec never names a frontend framework, so the UI is plain HTML/CSS/JS with
 * no build step (README -> "Underspecified areas" 5.6 records this decision). It
 * is served as static files from GameComponent, which is exactly the
 * `GameServer -- UserClient` / `GameServer -- AdminClient` edges: the browser
 * talks to the same origin it was loaded from, so no CORS or proxy config is
 * needed for the game itself.
 *
 * Layout:
 *   web/index.html        intro movie -> main menu -> question screens -> ending
 *   web/admin.html        AdminClient: sign in + updateQuestions
 *   web/app.js            game client (real API calls)
 *   web/admin.js          admin client (real admin API calls)
 *   web/styles.css        shared "space" theme
 *
 * The only thing the static client cannot do from the game origin is reach
 * UserComponent's token endpoint on a different port, so this module also
 * exposes a same-origin `POST /oauth/token` proxy. That proxy is additive (it is
 * not in the spec's one-path API) and is documented in openapi.yaml.
 */
const WEB_ROOT = path.resolve(__dirname, '../../../../web');

/** Public URL prefix the UI is served under. */
const WEB_BASE_PATH = '/';

function createStaticUIRoutes({ logger, webRoot = WEB_ROOT, userBaseUrl = null } = {}) {
  const router = express.Router();
  const { config } = shared;

  router.get('/ui-config.js', (req, res) => {
    // Runtime config instead of a build-time constant, so the same image can be
    // pointed at a different API origin (e.g. a separate gateway) without a
    // rebuild.
    res.type('application/javascript').send(
      `window.SPACE_FRACTIONS_CONFIG = ${JSON.stringify(
        {
          apiBase: process.env.PUBLIC_API_BASE || '',
          userApiBase: process.env.PUBLIC_USER_API_BASE || '',
          version: '1.0.0',
        },
        null,
        2,
      )};\n`,
    );
  });

  /**
   * Same-origin OAuth2 token proxy -> UserComponent (section F).
   *
   * AdminClient needs a token from UserComponent; when the UI is served by
   * GameComponent that is a different origin. Rather than asking the operator to
   * set CORS_ORIGIN on UserComponent, we proxy the RFC 6749 form POST through the
   * game origin. Additive route - see openapi.yaml.
   */
  router.post('/oauth/token', express.urlencoded({ extended: false }), async (req, res, next) => {
    const target = userBaseUrl
      || process.env.PUBLIC_USER_API_BASE
      || shared.http.createServiceRegistry(config).user;
    try {
      const form = new URLSearchParams(req.body || {}).toString();
      const upstream = await fetch(`${target}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      const text = await upstream.text();
      res.status(upstream.status).type('application/json').send(text);
    } catch (err) {
      logger && logger.warn({ err: err.message, target }, 'oauth token proxy failed');
      // Degrade with a clear OAuth-style error rather than a 500 page: the admin
      // screen surfaces error_description verbatim.
      res.status(502).json({
        error: 'temporarily_unavailable',
        error_description: `UserComponent token endpoint unreachable at ${target}: ${err.message}`,
      });
      if (next) { /* handled */ }
    }
  });

  router.use(
    express.static(webRoot, {
      index: 'index.html',
      extensions: ['html'],
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('cache-control', 'no-cache');
      },
    }),
  );

  // AdminClient sits at /admin (the DeploymentDiagram's AdminClient node).
  router.get('/admin', (req, res) => res.sendFile(path.join(webRoot, 'admin.html')));
  router.get('/play-ui', (req, res) => res.sendFile(path.join(webRoot, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  router.use((req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
    logger && logger.debug({ path: req.path }, 'web asset not found');
    return res.status(404).json({ error: 'not_found', error_description: `No web asset for ${req.path}` });
  });

  return router;
}

module.exports = { createStaticUIRoutes, WEB_ROOT, WEB_BASE_PATH };
