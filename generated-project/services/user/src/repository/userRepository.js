'use strict';

const { User } = require('../domain/user');

/**
 * UserRepository - persistence for UserComponent.
 *
 * Section F: "Implement OAuth2 for authentication and authorization",
 * "Use secure password storage and transmission",
 * "Use a secrets manager like Hashicorp's Vault", "Rotate secrets regularly".
 *
 * Refresh tokens are stored as SHA-256 hashes (never raw) so a database leak
 * does not hand over live credentials; that is the rotation-friendly design
 * section F implies.
 */
class UserRepository {
  constructor({ pool, cache, logger, schema = 'user', metrics = null }) {
    this.pool = pool;
    this.cache = cache;
    this.logger = logger;
    this.schema = schema;
    this.metrics = metrics;
  }

  get usersTable() {
    return `${this.schema}.users`;
  }

  get refreshTable() {
    return `${this.schema}.refresh_tokens`;
  }

  async insert(user) {
    const sql = `
      INSERT INTO ${this.usersTable}
        (user_uid, username, role, password_hash, password_salt, email, display_name, active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id, user_uid, created_at, updated_at
    `;
    const params = [
      user.id,
      user.username,
      user.role,
      user.passwordHash,
      user.passwordSalt,
      user.email,
      user.displayName,
      user.active,
    ];
    const op = () => this.pool.query(sql, params);
    const { rows } = this.metrics
      ? await this.metrics.timeExternal('postgres', 'insertUser', op)
      : await op();
    return rows[0];
  }

  async findByUsername(username) {
    const op = () => this.pool.query(
      `SELECT * FROM ${this.usersTable} WHERE lower(username) = lower($1) LIMIT 1`,
      [username],
    );
    const { rows } = await this.metrics
      ? await this.metrics.timeExternal('postgres', 'findUserByUsername', op)
      : await op();
    return rows[0] ? User.fromJSON(rowToUser(rows[0])) : null;
  }

  async findById(userId) {
    const cacheKey = `user:${userId}`;
    if (this.cache) {
      const cached = await this.cache.get(cacheKey);
      if (cached) return User.fromJSON(cached);
    }
    const op = () => this.pool.query(
      `SELECT * FROM ${this.usersTable} WHERE user_uid = $1 LIMIT 1`,
      [userId],
    );
    const { rows } = await this.metrics
      ? await this.metrics.timeExternal('postgres', 'findUserById', op)
      : await op();
    if (!rows[0]) return null;
    const user = User.fromJSON(rowToUser(rows[0]));
    if (this.cache) await this.cache.set(cacheKey, user.toJSON(), 300);
    return user;
  }

  async count() {
    const { rows } = await this.pool.query(`SELECT COUNT(*)::int AS count FROM ${this.usersTable}`);
    return rows[0].count;
  }

  async setActive(userId, active) {
    const { rows } = await this.pool.query(
      `UPDATE ${this.usersTable} SET active = $2, updated_at = NOW()
        WHERE user_uid = $1 RETURNING user_uid`,
      [userId, active],
    );
    if (this.cache) await this.cache.del(`user:${userId}`);
    return rows.length > 0;
  }

  /** Store only the SHA-256 hash of a refresh token. */
  async storeRefreshToken(userId, token, expiresAt) {
    const hash = hashToken(token);
    await this.pool.query(
      `INSERT INTO ${this.refreshTable} (user_uid, token_hash, expires_at, revoked)
       VALUES ($1,$2,$3,FALSE)
       ON CONFLICT (token_hash) DO NOTHING`,
      [userId, hash, expiresAt],
    );
    return hash;
  }

  async findRefreshToken(token) {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.refreshTable}
        WHERE token_hash = $1 AND revoked = FALSE AND expires_at > NOW() LIMIT 1`,
      [hashToken(token)],
    );
    return rows[0] || null;
  }

  async revokeRefreshToken(token) {
    await this.pool.query(
      `UPDATE ${this.refreshTable} SET revoked = TRUE WHERE token_hash = $1`,
      [hashToken(token)],
    );
  }

  /** Section F: "Rotate secrets regularly" - purge expired refresh tokens. */
  async purgeExpiredRefreshTokens() {
    const { rowCount } = await this.pool.query(
      `DELETE FROM ${this.refreshTable} WHERE expires_at <= NOW() OR revoked = TRUE`,
    );
    return rowCount;
  }
}

function hashToken(token) {
  // eslint-disable-next-line global-require
  return require('crypto').createHash('sha256').update(String(token)).digest('hex');
}

function rowToUser(row) {
  return {
    id: row.user_uid,
    username: row.username,
    role: row.role,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    email: row.email,
    displayName: row.display_name,
    active: row.active,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
  };
}

module.exports = { UserRepository, rowToUser, hashToken };
