-- Space Fractions - UserComponent schema
--
-- Section F of the spec: OAuth2 authentication and authorization, secure
-- password storage and transmission, secrets management and rotation (Vault),
-- TLS everywhere, Istio service mesh, and a threat model covering unauthorized
-- access, data breaches, denial of service, malware and phishing.
--
-- The ClassDiagram gives User { id, username } and Admin { id, username }.
-- Columns beyond those two are required to implement section F at all:
-- role, password_hash, password_salt, active. See README.

CREATE SCHEMA IF NOT EXISTS user_svc;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS user_svc.users (
  id              SERIAL PRIMARY KEY,
  user_uid        UUID NOT NULL DEFAULT gen_random_uuid(),
  username        TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'student'
                    CHECK (role IN ('student', 'teacher', 'admin')),
  -- scrypt output (64 bytes, hex) and a per-user 16-byte random salt.
  -- Section F: "Use secure password storage and transmission" - never plaintext,
  -- never a fast unsalted digest.
  password_hash   TEXT NOT NULL,
  password_salt   TEXT NOT NULL,
  email           TEXT,
  display_name    TEXT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at   TIMESTAMPTZ,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_user_uid_key UNIQUE (user_uid),
  CONSTRAINT users_username_len CHECK (char_length(username) >= 3)
);

-- Case-insensitive uniqueness: students must not be able to register "Ada" and
-- "ada" as separate accounts.
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx
  ON user_svc.users (lower(username));

CREATE INDEX IF NOT EXISTS users_role_idx ON user_svc.users (role) WHERE active = TRUE;

COMMENT ON TABLE user_svc.users IS 'UserComponent accounts (section F: OAuth2 authn/authz). Owned exclusively by the UserComponent service.';
COMMENT ON COLUMN user_svc.users.password_hash IS 'scrypt(password, password_salt, 64). Compared with a constant-time equality check.';
COMMENT ON COLUMN user_svc.users.failed_attempts IS 'Supports the "denial of service" and "unauthorized access" mitigations in the section F threat model.';

-- ---------------------------------------------------------------------------
-- Refresh tokens.
--
-- Section F: "Rotate secrets regularly". Only the SHA-256 hash of a refresh
-- token is stored, so a database compromise does not yield usable credentials,
-- and every rotation issues a fresh token and revokes the presented one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_svc.refresh_tokens (
  id          BIGSERIAL PRIMARY KEY,
  user_uid    UUID NOT NULL,
  token_hash  TEXT NOT NULL,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT refresh_tokens_hash_key UNIQUE (token_hash),
  CONSTRAINT refresh_tokens_user_fk FOREIGN KEY (user_uid)
    REFERENCES user_svc.users (user_uid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx
  ON user_svc.refresh_tokens (user_uid, expires_at DESC);

CREATE INDEX IF NOT EXISTS refresh_tokens_live_idx
  ON user_svc.refresh_tokens (expires_at) WHERE revoked = FALSE;

COMMENT ON TABLE user_svc.refresh_tokens IS 'Hashed refresh tokens with rotation. Purged on a schedule (section F secret rotation).';

-- ---------------------------------------------------------------------------
-- Authorization audit trail. Every allow/deny decision is recorded so the
-- section F threat model ("monitor for suspicious activity") has evidence.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_svc.authz_audit (
  id          BIGSERIAL PRIMARY KEY,
  user_uid    UUID,
  username    TEXT,
  scope       TEXT,
  decision    TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason      TEXT,
  source_ip   INET,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS authz_audit_user_idx
  ON user_svc.authz_audit (user_uid, occurred_at DESC);

COMMENT ON TABLE user_svc.authz_audit IS 'Append-only authorization decisions (section F: monitor for suspicious activity).';

REVOKE DELETE ON user_svc.authz_audit FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Least privilege for the read replica and the application role.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spacefractions_standby') THEN
    CREATE ROLE spacefractions_standby WITH LOGIN REPLICATION;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA user_svc TO spacefractions_standby;
GRANT SELECT ON ALL TABLES IN SCHEMA user_svc TO spacefractions_standby;
ALTER DEFAULT PRIVILEGES IN SCHEMA user_svc GRANT SELECT ON TABLES TO spacefractions_standby;

COMMENT ON SCHEMA user_svc IS 'ASR-2 (security): OAuth2 accounts, hashed refresh tokens, append-only authz audit.';
