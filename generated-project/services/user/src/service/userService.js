'use strict';

const crypto = require('crypto');
const shared = require('@spacefractions/shared');
const { oauth2 } = shared;
const { User, Admin } = require('../domain/user');

/**
 * UserService - application layer behind UserComponent.
 *
 * Responsibilities (spec section C): "user authentication and authorization".
 * Section F: OAuth2, secure password storage/transmission, secrets rotation.
 *
 * The spec names OAuth2 but no identity provider, so UserComponent acts as its
 * own minimal OAuth2 authorization server supporting:
 *   - password grant  (students logging in from the web client)
 *   - client_credentials (component-to-component machine tokens)
 *   - refresh_token grant
 * See README -> "Underspecified areas".
 */
class UserService {
  constructor({ repository, messaging, metrics, logger, config }) {
    this.repository = repository;
    this.messaging = messaging;
    this.metrics = metrics;
    this.logger = logger;
    this.config = config;
  }

  async register({ username, password, role = oauth2.ROLES.STUDENT, email = null, displayName = null }) {
    if (!username || String(username).trim().length < 3) {
      throw httpError(400, 'invalid_request', 'username must be at least 3 characters');
    }
    if (!Object.values(oauth2.ROLES).includes(role)) {
      throw httpError(400, 'invalid_request', `role must be one of ${Object.values(oauth2.ROLES).join(', ')}`);
    }
    const existing = await this.repository.findByUsername(username);
    if (existing) {
      throw httpError(409, 'user_exists', `username ${username} is already taken`);
    }

    const user = role === oauth2.ROLES.ADMIN
      ? new Admin({ username, email, displayName })
      : new User({ username, role, email, displayName });
    user.setPassword(password);

    await this.repository.insert(user);
    return user.toJSON();
  }

  /** OAuth2 password grant. */
  async authenticate({ username, password, scope = null }) {
    const user = await this.repository.findByUsername(username);

    // Always run a hash comparison so a missing user and a wrong password take
    // comparable time (avoids username enumeration).
    const dummy = new User({ username: '__nonexistent__' });
    dummy.setPassword('placeholder-not-a-real-password');
    const ok = user ? user.verifyPassword(password) : (dummy.verifyPassword(password), false);

    if (!user || !ok) {
      throw httpError(401, 'invalid_grant', 'Invalid username or password');
    }
    if (!user.active) {
      throw httpError(403, 'account_disabled', 'This account has been disabled');
    }

    const grantedScopes = scope ? String(scope).split(' ').filter(Boolean) : user.scopes;
    const token = this.issueToken(user, grantedScopes);
    const refreshToken = await this.issueRefreshToken(user);

    if (this.messaging) {
      await this.messaging.publish(this.config.rabbitmq.events.userAuthenticated, {
        userId: user.id,
        username: user.username,
        role: user.role,
        grantType: 'password',
      });
    }

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: grantedScopes.join(' '),
      user: user.toJSON(),
    };
  }

  /** OAuth2 client_credentials grant for service-to-service calls. */
  issueServiceToken({ clientId, clientSecret, scope = null }) {
    const expectedId = process.env.SERVICE_CLIENT_ID || 'spacefractions-internal';
    const expectedSecret = process.env.SERVICE_CLIENT_SECRET || 'internal-secret-change-me';

    const idOk = safeEquals(clientId || '', expectedId);
    const secretOk = safeEquals(clientSecret || '', expectedSecret);
    if (!idOk || !secretOk) {
      throw httpError(401, 'invalid_client', 'Invalid client credentials');
    }

    const grantedScopes = scope ? String(scope).split(' ').filter(Boolean) : Object.values(oauth2.SCOPES);
    const now = Math.floor(Date.now() / 1000);
    const token = oauth2.signToken(
      {
        sub: 'service:spacefractions-internal',
        username: expectedId,
        role: oauth2.ROLES.ADMIN,
        roles: [oauth2.ROLES.ADMIN],
        scope: grantedScopes.join(' '),
        iat: now,
        client_id: expectedId,
      },
      '1h',
    );
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: grantedScopes.join(' '),
    };
  }

  issueToken(user, scopes) {
    const now = Math.floor(Date.now() / 1000);
    return oauth2.signToken({
      sub: user.id,
      username: user.username,
      role: user.role,
      roles: [user.role],
      scope: scopes.join(' '),
      iat: now,
    });
  }

  /** Section F secret rotation: refresh tokens are short lived and hashed. */
  async issueRefreshToken(user) {
    const token = crypto.randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    await this.repository.storeRefreshToken(user.id, token, expiresAt);
    return token;
  }

  /** OAuth2 refresh_token grant, with rotation on every use. */
  async refresh({ refreshToken }) {
    if (!refreshToken) throw httpError(400, 'invalid_request', 'refresh_token is required');
    const record = await this.repository.findRefreshToken(refreshToken);
    if (!record) throw httpError(401, 'invalid_grant', 'Refresh token is invalid, expired or revoked');

    const user = await this.repository.findById(record.user_uid);
    if (!user || !user.active) throw httpError(401, 'invalid_grant', 'Account is not active');

    // Rotate: revoke the presented token, issue a new one.
    await this.repository.revokeRefreshToken(refreshToken);
    const newRefresh = await this.issueRefreshToken(user);
    const scopes = user.scopes;

    return {
      access_token: this.issueToken(user, scopes),
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: newRefresh,
      scope: scopes.join(' '),
      user: user.toJSON(),
    };
  }

  async me(userId) {
    const user = await this.repository.findById(userId);
    if (!user) throw httpError(404, 'user_not_found', `User ${userId} not found`);
    return user.toJSON();
  }

  async list({ limit = 50, offset = 0 } = {}) {
    const { rows } = await this.repository.pool.query(
      `SELECT * FROM ${this.repository.usersTable} ORDER BY created_at LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return {
      users: rows.map((r) => User.fromJSON(require('../repository/userRepository').rowToUser(r)).toJSON()),
      total: await this.repository.count(),
    };
  }

  /** Short-lived authorization decisions for other components. */
  async authorise(userId, scope) {
    const user = await this.repository.findById(userId);
    if (!user) return { authorised: false, reason: 'user_not_found' };
    const granted = user.scopes.includes(scope) || user.role === oauth2.ROLES.ADMIN;
    return { authorised: granted, roles: [user.role], scopes: user.scopes };
  }

  /**
   * Bootstrap an admin account so the UseCaseDiagram's Admin actor can log in.
   * Password comes from ADMIN_PASSWORD or is generated and logged once.
   */
  async ensureAdmin() {
    const existing = await this.repository.findByUsername('admin');
    if (existing) return { created: false, username: 'admin' };

    const password = process.env.ADMIN_PASSWORD || `admin-${crypto.randomBytes(6).toString('hex')}`;
    const admin = new Admin({ username: 'admin', displayName: 'Administrator' });
    admin.setPassword(password);
    await this.repository.insert(admin);
    if (!process.env.ADMIN_PASSWORD) {
      this.logger.warn(
        { username: 'admin', generatedPassword: password },
        'generated bootstrap admin password - set ADMIN_PASSWORD to control this',
      );
    }
    return { created: true, username: 'admin' };
  }
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function safeEquals(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = { UserService };
