-- Space Fractions - QuestionComponent schema
--
-- The artifact named against ASR-1 ("Data durability - ensures that question
-- data is persisted and recoverable") in the traceability matrix is
-- sql/question_ddl.sql, while the deliverables list names sql/game_ddl.sql.
-- Both files are generated. See README -> "Underspecified areas": the spec's own
-- deliverables list and its traceability matrix disagree about which DDL
-- filename exists, so we emit both.
--
-- The ClassDiagram gives Question as:
--   - id: string
--   - prompt: string
--   - options: List<string>
--   + getPrompt(): string
--   + getOptions(): List<string>
--
-- `correct_option` is not in the class diagram, but SequenceDiagram1's
-- "Game ->> Question : check answer" step cannot work without an answer key, so
-- it is added here and never returned to students.
--
-- ASR-1 mitigations from section D/E, expressed in schema:
--   "Use PostgreSQL replication for high availability"
--   "Implement regular backups and data replication"   -> RPO 1h / RTO 1h (section G)

CREATE SCHEMA IF NOT EXISTS question;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS question.questions (
  id              SERIAL PRIMARY KEY,
  question_uid    UUID NOT NULL DEFAULT gen_random_uuid(),
  prompt          TEXT NOT NULL,
  options         JSONB NOT NULL,
  correct_option  TEXT NOT NULL,
  difficulty      TEXT NOT NULL DEFAULT 'medium'
                    CHECK (difficulty IN ('easy', 'medium', 'hard')),
  weight          NUMERIC(4,2) NOT NULL DEFAULT 1.00 CHECK (weight >= 0),
  tags            JSONB NOT NULL DEFAULT '[]'::jsonb,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT questions_question_uid_key UNIQUE (question_uid),
  CONSTRAINT questions_options_is_array CHECK (jsonb_typeof(options) = 'array'),
  CONSTRAINT questions_tags_is_array CHECK (jsonb_typeof(tags) = 'array'),
  -- The answer key must be one of the offered options. Enforced in the DB as
  -- well as in the domain Question.validate() so a bad row can never be stored.
  CONSTRAINT questions_correct_option_in_options
    CHECK (options @> to_jsonb(correct_option))
);

-- Add the UUID unique constraint when upgrading an older table that lacks it.
-- (Kept as a separate idempotent statement for migration friendliness.)
CREATE UNIQUE INDEX IF NOT EXISTS questions_question_uid_idx
  ON question.questions (question_uid);

CREATE INDEX IF NOT EXISTS questions_difficulty_idx
  ON question.questions (difficulty) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS questions_active_idx
  ON question.questions (active);
CREATE INDEX IF NOT EXISTS questions_created_at_idx
  ON question.questions (created_at);
CREATE INDEX IF NOT EXISTS questions_tags_gin_idx
  ON question.questions USING GIN (tags);
CREATE INDEX IF NOT EXISTS questions_prompt_trgm_idx
  ON question.questions USING GIN (to_tsvector('english', prompt));

COMMENT ON TABLE question.questions IS 'QuestionComponent question bank (ASR-1 data durability). Owned exclusively by the QuestionComponent service.';
COMMENT ON COLUMN question.questions.correct_option IS 'Answer key. MUST NOT be exposed to student-facing responses; strip it in Question.toPublicJSON().';
COMMENT ON COLUMN question.questions.active IS 'Soft delete flag. Questions are never hard-deleted so historical game answers stay interpretable (durability).';

-- ---------------------------------------------------------------------------
-- Immutable audit trail: makes "question data is persisted and recoverable"
-- (ASR-1) auditable. Every mutation is recorded with the previous image, which
-- is the recovery record used by the DR runbook in section G.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question.question_audit (
  id              BIGSERIAL PRIMARY KEY,
  question_uid    UUID NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('insert', 'update', 'deactivate', 'restore')),
  previous_state  JSONB,
  new_state       JSONB,
  actor           TEXT,
  version         INTEGER,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS question_audit_uid_idx
  ON question.question_audit (question_uid, occurred_at DESC);

COMMENT ON TABLE question.question_audit IS 'Append-only audit log used to recover a question to any prior version (ASR-1).';

CREATE OR REPLACE FUNCTION question.record_question_audit()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    INSERT INTO question.question_audit
      (question_uid, action, previous_state, new_state, version)
    VALUES (NEW.question_uid, 'insert', NULL, to_jsonb(NEW), NEW.version);
    RETURN NEW;
  ELSIF (TG_OP = 'UPDATE') THEN
    INSERT INTO question.question_audit
      (question_uid, action, previous_state, new_state, version)
    VALUES (
      NEW.question_uid,
      CASE WHEN OLD.active = TRUE AND NEW.active = FALSE THEN 'deactivate' ELSE 'update' END,
      to_jsonb(OLD),
      to_jsonb(NEW),
      NEW.version
    );
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS questions_audit_trg ON question.questions;
CREATE TRIGGER questions_audit_trg
  AFTER INSERT OR UPDATE ON question.questions
  FOR EACH ROW EXECUTE FUNCTION question.record_question_audit();

-- ---------------------------------------------------------------------------
-- Read replica role for the "data replication for high availability" mitigation.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spacefractions_standby') THEN
    CREATE ROLE spacefractions_standby WITH LOGIN REPLICATION;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA question TO spacefractions_standby;
GRANT SELECT ON ALL TABLES IN SCHEMA question TO spacefractions_standby;
ALTER DEFAULT PRIVILEGES IN SCHEMA question GRANT SELECT ON TABLES TO spacefractions_standby;

-- Least privilege: the application role must not be able to drop the audit
-- trail. Section F (threat model: "unauthorized access", "data breaches").
REVOKE DELETE ON question.question_audit FROM PUBLIC;

COMMENT ON SCHEMA question IS 'ASR-1: persisted and recoverable. RPO 1h / RTO 1h (spec section G). Streaming replication to >=1 standby + hourly base backups.';
