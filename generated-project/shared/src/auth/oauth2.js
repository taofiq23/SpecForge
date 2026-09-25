'use strict';

const jwt = require('jsonwebtoken');
const jwksRsa = require('jwks-rsa');
const config = require('../config');

/**
 * OAuth2 authentication / authorization (spec section D: "Authn/authz: OAuth2",
 * section F: "Implement OAuth2 for authentication and authorization / Use
 * secure password storage and transmission").
 *
 * Supports two verification modes:
 *   1. JWKS (production, service mesh / real IdP): set OAUTH2_JWKS_URI.
 *   2. HS256 shared secret (local dev + the UserComponent's own token issuer).
 *
 * The spec never names an identity provider or token endpoint, so the
 * UserComponent issues its own OAuth2 client-credentials + password-grant style
 * tokens. Documented in README -> "Underspecified areas".
 */

const ROLES = Object.freeze({
  STUDENT: 'student',
  TEACHER: 'teacher',
  ADMIN: 'admin',
});

const SCOPES = Object.freeze({
  PLAY_GAME: 'game:play',
  VIEW_SCORE: 'game:score:read',
  UPDATE_QUESTIONS: 'questions:write',
  READ_QUESTIONS: 'questions:read',
  VIEW_HELP: 'help:read',
});

const ROLE_SCOPES = Object.freeze({
  [ROLES.STUDENT]: [SCOPES.PLAY_GAME, SCOPES.VIEW_SCORE, SCOPES.READ_QUESTIONS, SCOPES.VIEW_HELP],
  [ROLES.TEACHER]: [SCOPES.READ_QUESTIONS, SCOPES.VIEW_SCORE, SCOPES.VIEW_HELP],
  [ROLES.ADMIN]: Object.values(SCOPES),
});

function createJwksClient() {
  if (!config.oauth2.jwksUri) return null;
  return jwksRsa({
    jwksUri: config.oauth2.jwksUri,
    cache: true,
    cacheMaxEntries: 10,
    cacheMaxAge: 10 * 60 * 1000,
    rateLimit: true,
    jwksRequestsPerMinute: 10,
  });
}

const jwksClient = createJwksClient();

function getKey(header, callback) {
  if (jwksClient) {
    jwksClient.getSigningKey(header.kid, (err, key) => {
      if (err) return callback(err);
      return callback(null, key.getPublicKey());
    });
    return;
  }
  callback(null, config.oauth2.secret);
}

/**
 * Verify a bearer token. Returns the decoded claims or throws.
 */
function verifyToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getKey,
      {
        algorithms: config.oauth2.jwksUri ? ['RS256'] : ['HS256'],
        audience: config.oauth2.audience,
        issuer: config.oauth2.issuer,
      },
      (err, decoded) => (err ? reject(err) : resolve(decoded)),
    );
  });
}

function signToken(claims, expiresIn = '1h') {
  return jwt.sign(claims, config.oauth2.secret, {
    algorithm: 'HS256',
    expiresIn,
    issuer: config.oauth2.issuer,
    audience: config.oauth2.audience,
  });
}

/**
 * Express middleware factory.
 *
 * @param {object} opts
 * @param {string[]} [opts.scopes]  scopes required to reach the route
 * @param {string[]} [opts.roles]   roles required in addition to scopes
 * @param {boolean} [opts.optional] when true, an absent token is allowed
 */
function authenticate(opts = {}) {
  const requiredScopes = opts.scopes || [];
  const requiredRoles = opts.roles || [];
  const optional = Boolean(opts.optional);

  return async function authMiddleware(req, res, next) {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (!token || scheme.toLowerCase() !== 'bearer') {
      if (optional) {
        req.user = null;
        return next();
      }
      return res.status(401).json({
        error: 'unauthorized',
        error_description: 'Missing OAuth2 bearer token',
      });
    }

    let claims;
    try {
      claims = await verifyToken(token);
    } catch (err) {
      return res.status(401).json({
        error: 'invalid_token',
        error_description: err.message,
      });
    }

    const grantedScopes = String(claims.scope || '').split(/\s+/).filter(Boolean);
    const grantedRoles = Array.isArray(claims.roles) ? claims.roles : [claims.role].filter(Boolean);

    const missingScopes = requiredScopes.filter((s) => !grantedScopes.includes(s) && !grantedScopes.includes('*'));
    if (missingScopes.length > 0) {
      return res.status(403).json({
        error: 'insufficient_scope',
        error_description: `Missing scope(s): ${missingScopes.join(', ')}`,
      });
    }

    const missingRoles = requiredRoles.filter((r) => !grantedRoles.includes(r));
    if (missingRoles.length > 0) {
      return res.status(403).json({
        error: 'insufficient_role',
        error_description: `Missing role(s): ${missingRoles.join(', ')}`,
      });
    }

    req.user = {
      id: claims.sub,
      username: claims.username || claims.preferred_username,
      roles: grantedRoles,
      scopes: grantedScopes,
      claims,
    };
    return next();
  };
}

function scopesForRole(role) {
  return ROLE_SCOPES[role] || [];
}

module.exports = {
  ROLES,
  SCOPES,
  ROLE_SCOPES,
  authenticate,
  verifyToken,
  signToken,
  scopesForRole,
};
