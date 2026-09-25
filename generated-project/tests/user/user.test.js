'use strict';

/**
 * UserComponent tests.
 *
 * Covers:
 *   - `User` / `Admin`, the two classes in the ClassDiagram (view 2)
 *   - section F security: OAuth2 authn/authz, secure password storage,
 *     refresh-token rotation, secret handling
 *   - the UseCaseDiagram Admin actor's Update Questions permission
 */
const { User, Admin } = require('../../services/user/src/domain/user');
const { UserService } = require('../../services/user/src/service/userService');
const { UserRepository } = require('../../services/user/src/repository/userRepository');
const shared = require('../../shared/src');
const config = require('../../shared/src/config');
const {
  FakePgPool,
  FakeRedisClient,
  createFakeCache,
  createFakeMessaging,
} = require('../helpers/fakes');

const silentLogger = { info() {}, debug() {}, warn() {}, error() {} };

function build() {
  const pool = new FakePgPool();
  const redis = new FakeRedisClient();
  const cache = createFakeCache(redis);
  const messaging = createFakeMessaging();
  const repository = new UserRepository({ pool, cache, logger: silentLogger, schema: 'user_svc' });
  const service = new UserService({ repository, messaging, metrics: null, logger: silentLogger, config });
  return { pool, redis, cache, messaging, repository, service };
}

describe('User (ClassDiagram: class User)', () => {
  test('has the diagram attributes id and username', () => {
    const user = new User({ username: 'astro' });
    expect(typeof user.id).toBe('string');
    expect(user.username).toBe('astro');
    expect(user.role).toBe('student');
  });

  test('setPassword stores a salted hash, never the plaintext', () => {
    const user = new User({ username: 'astro' });
    user.setPassword('correct-horse-battery');

    expect(user.passwordHash).toBeDefined();
    expect(user.passwordSalt).toBeDefined();
    expect(user.passwordHash).not.toContain('correct-horse-battery');
    // toJSON must never carry credential material.
    expect(JSON.stringify(user.toJSON())).not.toContain(user.passwordHash);
    expect(user.toJSON()).not.toHaveProperty('passwordHash');
    expect(user.toJSON()).not.toHaveProperty('passwordSalt');
  });

  test('two users with the same password get different salts and hashes', () => {
    const a = new User({ username: 'a' }).setPassword('same-password-here');
    const b = new User({ username: 'b' }).setPassword('same-password-here');
    expect(a.passwordSalt).not.toBe(b.passwordSalt);
    expect(a.passwordHash).not.toBe(b.passwordHash);
  });

  test('rejects a password shorter than 8 characters', () => {
    const user = new User({ username: 'astro' });
    expect(() => user.setPassword('short')).toThrow(/at least 8 characters/);
    try {
      user.setPassword('short');
    } catch (err) {
      expect(err.status).toBe(400);
      expect(err.code).toBe('weak_password');
    }
  });

  test('verifyPassword accepts the right password and rejects others', () => {
    const user = new User({ username: 'astro' }).setPassword('correct-horse-battery');
    expect(user.verifyPassword('correct-horse-battery')).toBe(true);
    expect(user.verifyPassword('wrong-horse-battery')).toBe(false);
  });

  test('verifyPassword returns false when no password is set, rather than throwing', () => {
    expect(new User({ username: 'astro' }).verifyPassword('anything')).toBe(false);
    expect(new User({ username: 'astro' }).verifyPassword(null)).toBe(false);
  });

  test('playGame(game) delegates to Game.play() (ClassDiagram signature)', () => {
    const game = { play: jest.fn(), state: 'Playing' };
    const user = new User({ username: 'astro' });
    user.playGame(game);
    expect(game.play).toHaveBeenCalledTimes(1);
    expect(typeof user.lastPlayedAt).toBe('string');
  });

  test('playGame() rejects a non-Game argument', () => {
    const user = new User({ username: 'astro' });
    expect(() => user.playGame(null)).toThrow(/requires a Game instance/);
    expect(() => user.playGame({})).toThrow(/requires a Game instance/);
  });

  test('viewScore(game) returns the game score (ClassDiagram signature)', () => {
    const user = new User({ username: 'astro' });
    expect(user.viewScore({ viewScore: () => 42 })).toBe(42);
  });

  test('scopes follow from the role', () => {
    expect(new User({ username: 's', role: 'student' }).scopes).toContain('game:play');
    expect(new User({ username: 's', role: 'student' }).scopes).not.toContain('questions:write');
    expect(new Admin({ username: 'a' }).scopes).toContain('questions:write');
  });

  test('fromJSON rehydrates a persisted row', () => {
    const user = new User({ username: 'astro' });
    expect(User.fromJSON(JSON.stringify(user.toJSON())).username).toBe('astro');
  });
});

describe('Admin (ClassDiagram: class Admin, Update Questions)', () => {
  test('is an admin-role User', () => {
    const admin = new Admin({ username: 'root' });
    expect(admin.role).toBe('admin');
    expect(admin.isAdmin()).toBe(true);
  });

  test('updateQuestions() validates and serialises every question', () => {
    const admin = new Admin({ username: 'root' });
    const valid = {
      validate: () => ({ valid: true, errors: [] }),
      toJSON: () => ({ id: 'q1', prompt: 'What is 1/2?' }),
    };
    const result = admin.updateQuestions([valid]);
    expect(result).toEqual([{ id: 'q1', prompt: 'What is 1/2?' }]);
    expect(typeof admin.updatedQuestionsAt).toBe('string');
  });

  test('updateQuestions() rejects an invalid question', () => {
    const admin = new Admin({ username: 'root' });
    const invalid = { validate: () => ({ valid: false, errors: ['prompt too short'] }) };
    expect(() => admin.updateQuestions([invalid])).toThrow(/prompt too short/);
  });

  test('updateQuestions() rejects a non-array argument', () => {
    expect(() => new Admin({ username: 'root' }).updateQuestions('nope')).toThrow(/array of questions/);
  });
});

describe('OAuth2 authentication (section F)', () => {
  test('register() then authenticate() issues a usable bearer token', async () => {
    const { service } = build();
    await service.register({ username: 'astro', password: 'a-good-password' });
    const tokens = await service.authenticate({ username: 'astro', password: 'a-good-password' });

    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.user.username).toBe('astro');
    expect(tokens.user).not.toHaveProperty('passwordHash');

    const claims = await shared.oauth2.verifyToken(tokens.access_token);
    expect(claims.username).toBe('astro');
    expect(claims.scope).toContain('game:play');
  });

  test('authenticate() rejects a wrong password with invalid_grant', async () => {
    const { service } = build();
    await service.register({ username: 'astro', password: 'a-good-password' });
    await expect(service.authenticate({ username: 'astro', password: 'nope-nope-nope' })).rejects.toMatchObject({
      status: 401,
      code: 'invalid_grant',
    });
  });

  test('authenticate() rejects an unknown user without revealing that it is unknown', async () => {
    const { service } = build();
    await expect(service.authenticate({ username: 'ghost', password: 'a-good-password' })).rejects.toMatchObject({
      status: 401,
      code: 'invalid_grant',
    });
  });

  test('authenticate() refuses a disabled account', async () => {
    const { service, pool } = build();
    await service.register({ username: 'astro', password: 'a-good-password' });
    pool.users[0].active = false;
    await expect(service.authenticate({ username: 'astro', password: 'a-good-password' })).rejects.toMatchObject({
      status: 403,
      code: 'account_disabled',
    });
  });

  test('register() rejects a duplicate username with 409', async () => {
    const { service } = build();
    await service.register({ username: 'astro', password: 'a-good-password' });
    await expect(service.register({ username: 'astro', password: 'another-password' })).rejects.toMatchObject({
      status: 409,
      code: 'user_exists',
    });
  });

  test('register() rejects a too-short username and an unknown role', async () => {
    const { service } = build();
    await expect(service.register({ username: 'ab', password: 'a-good-password' })).rejects.toMatchObject({ status: 400 });
    await expect(
      service.register({ username: 'astro', password: 'a-good-password', role: 'wizard' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  test('registering an admin yields the Admin domain class', async () => {
    const { service } = build();
    const created = await service.register({ username: 'root', password: 'a-good-password', role: 'admin' });
    expect(created.role).toBe('admin');
    expect(created.scopes).toContain('questions:write');
  });

  test('authenticate() publishes user.authenticated', async () => {
    const { service, messaging } = build();
    await service.register({ username: 'astro', password: 'a-good-password' });
    await service.authenticate({ username: 'astro', password: 'a-good-password' });
    const events = messaging.events(config.rabbitmq.events.userAuthenticated);
    expect(events).toHaveLength(1);
    expect(events[0].payload.username).toBe('astro');
  });

  test('a requested scope narrower than the role is honoured', async () => {
    const { service } = build();
    await service.register({ username: 'astro', password: 'a-good-password' });
    const tokens = await service.authenticate({
      username: 'astro', password: 'a-good-password', scope: 'help:read',
    });
    expect(tokens.scope).toBe('help:read');
  });
});

describe('OAuth2 client_credentials grant (service-to-service)', () => {
  test('correct client credentials yield an admin-scoped service token', () => {
    const { service } = build();
    const token = service.issueServiceToken({
      clientId: process.env.SERVICE_CLIENT_ID || 'spacefractions-internal',
      clientSecret: process.env.SERVICE_CLIENT_SECRET || 'internal-secret-change-me',
    });
    expect(token.access_token).toBeTruthy();
    expect(token.scope).toContain('questions:write');
  });

  test('a wrong client secret is rejected with invalid_client', () => {
    const { service } = build();
    expect(() => service.issueServiceToken({ clientId: 'spacefractions-internal', clientSecret: 'wrong' }))
      .toThrow(/Invalid client credentials/);
  });

  test('missing client credentials are rejected', () => {
    const { service } = build();
    expect(() => service.issueServiceToken({})).toThrow(/Invalid client credentials/);
  });
});

describe('OAuth2 refresh_token grant with rotation (section F rotation policy)', () => {
  test('a refresh token yields a new access token', async () => {
    const { service } = build();
    await service.register({ username: 'astro', password: 'a-good-password' });
    const first = await service.authenticate({ username: 'astro', password: 'a-good-password' });

    const refreshed = await service.refresh({ refreshToken: first.refresh_token });
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.refresh_token).not.toBe(first.refresh_token);
  });

  test('the presented refresh token is revoked after use (rotation)', async () => {
    const { service } = build();
    await service.register({ username: 'astro', password: 'a-good-password' });
    const first = await service.authenticate({ username: 'astro', password: 'a-good-password' });
    await service.refresh({ refreshToken: first.refresh_token });

    await expect(service.refresh({ refreshToken: first.refresh_token })).rejects.toMatchObject({
      status: 401,
      code: 'invalid_grant',
    });
  });

  test('a missing refresh token is a 400', async () => {
    const { service } = build();
    await expect(service.refresh({})).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
  });

  test('an unknown refresh token is rejected', async () => {
    const { service } = build();
    await expect(service.refresh({ refreshToken: 'made-up' })).rejects.toMatchObject({ status: 401 });
  });

  test('refresh tokens are stored hashed, not in plaintext', async () => {
    const { service, pool } = build();
    await service.register({ username: 'astro', password: 'a-good-password' });
    const tokens = await service.authenticate({ username: 'astro', password: 'a-good-password' });

    expect(pool.refreshTokens).toHaveLength(1);
    expect(pool.refreshTokens[0].token_hash).not.toBe(tokens.refresh_token);
  });

  test('purgeExpiredRefreshTokens removes expired rows', async () => {
    const { service, repository, pool } = build();
    await service.register({ username: 'astro', password: 'a-good-password' });
    await service.authenticate({ username: 'astro', password: 'a-good-password' });
    pool.refreshTokens[0].expires_at = new Date(Date.now() - 1000).toISOString();

    const purged = await repository.purgeExpiredRefreshTokens();
    expect(purged).toBe(1);
  });
});

describe('Authorization decisions (section F authn/authz)', () => {
  test('authorise() grants a scope the role holds', async () => {
    const { service } = build();
    const user = await service.register({ username: 'astro', password: 'a-good-password' });
    const decision = await service.authorise(user.id, 'game:play');
    expect(decision.authorised).toBe(true);
  });

  test('authorise() denies a scope the role does not hold', async () => {
    const { service } = build();
    const user = await service.register({ username: 'astro', password: 'a-good-password' });
    const decision = await service.authorise(user.id, 'questions:write');
    expect(decision.authorised).toBe(false);
  });

  test('authorise() grants an admin everything', async () => {
    const { service } = build();
    const admin = await service.register({ username: 'root', password: 'a-good-password', role: 'admin' });
    const decision = await service.authorise(admin.id, 'questions:write');
    expect(decision.authorised).toBe(true);
  });

  test('authorise() for an unknown user is a denial, not an error', async () => {
    const { service } = build();
    const decision = await service.authorise('ghost', 'game:play');
    expect(decision.authorised).toBe(false);
    expect(decision.reason).toBe('user_not_found');
  });

  test('an issued admin token actually satisfies the admin route guard', async () => {
    const { service } = build();
    await service.register({ username: 'root', password: 'a-good-password', role: 'admin' });
    const tokens = await service.authenticate({ username: 'root', password: 'a-good-password' });

    const claims = await shared.oauth2.verifyToken(tokens.access_token);
    expect(claims.roles).toContain('admin');
    expect(claims.scope).toContain('questions:write');
  });

  test('a student token does not satisfy the admin route guard', async () => {
    const { service } = build();
    await service.register({ username: 'astro', password: 'a-good-password' });
    const tokens = await service.authenticate({ username: 'astro', password: 'a-good-password' });

    const claims = await shared.oauth2.verifyToken(tokens.access_token);
    expect(claims.scope).not.toContain('questions:write');
  });
});

describe('UserService reads and bootstrap', () => {
  test('me() returns the current user', async () => {
    const { service } = build();
    const user = await service.register({ username: 'astro', password: 'a-good-password' });
    expect((await service.me(user.id)).username).toBe('astro');
  });

  test('me() on an unknown id is a 404', async () => {
    const { service } = build();
    await expect(service.me('ghost')).rejects.toMatchObject({ status: 404 });
  });

  test('list() returns a page of users and a total', async () => {
    const { service } = build();
    await service.register({ username: 'astro', password: 'a-good-password' });
    await service.register({ username: 'comet', password: 'a-good-password' });
    const page = await service.list({ limit: 10, offset: 0 });
    expect(page.users).toHaveLength(2);
    expect(page.total).toBe(2);
  });

  test('list() never leaks password material', async () => {
    const { service } = build();
    await service.register({ username: 'astro', password: 'a-good-password' });
    const page = await service.list({ limit: 10, offset: 0 });
    expect(page.users[0]).not.toHaveProperty('passwordHash');
  });

  test('ensureAdmin() bootstraps the admin actor from the UseCaseDiagram, idempotently', async () => {
    const { service } = build();
    const first = await service.ensureAdmin();
    expect(first.created).toBe(true);
    const second = await service.ensureAdmin();
    expect(second.created).toBe(false);
  });

  test('findByUsername is case-insensitive', async () => {
    const { service, repository } = build();
    await service.register({ username: 'Astro', password: 'a-good-password' });
    expect(await repository.findByUsername('astro')).toBeTruthy();
  });
});
