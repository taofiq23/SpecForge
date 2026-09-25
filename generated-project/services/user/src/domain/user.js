'use strict';

const crypto = require('crypto');
const shared = require('@spacefractions/shared');
const { oauth2 } = shared;
const { newId } = shared.domain;

/**
 * User - the class named in the ClassDiagram (spec.json view 2):
 *
 *   class User {
 *     - id: string
 *     - username: string
 *     + playGame(game: Game): void
 *     + viewScore(game: Game): int
 *   }
 *   class Admin {
 *     - id: string
 *     - username: string
 *     + updateQuestions(questions: List<Question>): void
 *   }
 *
 * Section F: "Use secure password storage and transmission" -> scrypt with a
 * per-user random salt and a constant-time comparison. Deviation from the
 * ClassDiagram: we add `passwordHash` and `role`, which the class diagram omits
 * but authentication requires. Documented in README.
 */
class User {
  constructor(props = {}) {
    this.id = props.id || newId();
    this.username = props.username;
    this.role = props.role || oauth2.ROLES.STUDENT;
    this.passwordHash = props.passwordHash || null;
    this.passwordSalt = props.passwordSalt || null;
    this.email = props.email || null;
    this.displayName = props.displayName || props.username || null;
    this.active = props.active === undefined ? true : Boolean(props.active);
    this.createdAt = props.createdAt || new Date().toISOString();
    this.updatedAt = props.updatedAt || new Date().toISOString();
  }

  /** Section F: "Use secure password storage" - scrypt, never plaintext. */
  setPassword(plaintext) {
    if (!plaintext || String(plaintext).length < 8) {
      const err = new Error('password must be at least 8 characters');
      err.status = 400;
      err.code = 'weak_password';
      throw err;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(plaintext), salt, 64).toString('hex');
    this.passwordSalt = salt;
    this.passwordHash = hash;
    this.updatedAt = new Date().toISOString();
    return this;
  }

  /** Constant-time verification to avoid timing side channels. */
  verifyPassword(plaintext) {
    if (!this.passwordHash || !this.passwordSalt || plaintext === undefined || plaintext === null) {
      return false;
    }
    const candidate = crypto.scryptSync(String(plaintext), this.passwordSalt, 64);
    const expected = Buffer.from(this.passwordHash, 'hex');
    if (candidate.length !== expected.length) return false;
    return crypto.timingSafeEqual(candidate, expected);
  }

  isAdmin() {
    return this.role === oauth2.ROLES.ADMIN;
  }

  /** ClassDiagram: + playGame(game: Game): void */
  playGame(game) {
    if (!game || typeof game.play !== 'function') {
      const err = new Error('playGame requires a Game instance');
      err.status = 400;
      err.code = 'invalid_game';
      throw err;
    }
    game.play();
    this.lastPlayedAt = new Date().toISOString();
    return game;
  }

  /** ClassDiagram: + viewScore(game: Game): int */
  viewScore(game) {
    if (!game || typeof game.viewScore !== 'function') {
      const err = new Error('viewScore requires a Game instance');
      err.status = 400;
      err.code = 'invalid_game';
      throw err;
    }
    return game.viewScore();
  }

  get scopes() {
    return oauth2.scopesForRole(this.role);
  }

  /** Never expose the hash or salt. */
  toJSON() {
    return {
      id: this.id,
      username: this.username,
      role: this.role,
      email: this.email,
      displayName: this.displayName,
      active: this.active,
      scopes: this.scopes,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  static fromJSON(json) {
    if (!json) return null;
    return new User(typeof json === 'string' ? JSON.parse(json) : json);
  }
}

/**
 * Admin - the second class in the ClassDiagram, kept as a real subclass so the
 * traceability matrix and the AdminComponent artifact both map to real symbols.
 *
 *   + updateQuestions(questions: List<Question>): void
 */
class Admin extends User {
  constructor(props = {}) {
    super({ ...props, role: oauth2.ROLES.ADMIN });
  }

  /** ClassDiagram: + updateQuestions(questions: List<Question>): void */
  updateQuestions(questions) {
    if (!Array.isArray(questions)) {
      const err = new Error('updateQuestions requires an array of questions');
      err.status = 400;
      err.code = 'invalid_questions';
      throw err;
    }
    this.updatedQuestionsAt = new Date().toISOString();
    return questions.map((q) => {
      if (!q || typeof q.validate !== 'function') {
        const err = new Error('every question must be a Question instance');
        err.status = 400;
        err.code = 'invalid_question';
        throw err;
      }
      const validation = q.validate();
      if (!validation.valid) {
        const err = new Error(validation.errors.join('; '));
        err.status = 400;
        err.code = 'invalid_question';
        throw err;
      }
      return q.toJSON();
    });
  }
}

module.exports = { User, Admin };
