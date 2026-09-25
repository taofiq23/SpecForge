-- Space Fractions - GameComponent schema
--
-- Verbatim from section D of the architecture spec:
--
--   CREATE TABLE games (
--     id SERIAL PRIMARY KEY,
--     game_state JSONB NOT NULL
--   );
--
-- The spec's statement is preserved below unchanged (aside from being wrapped in
-- a schema). Two EXTRA columns are added because the generated code needs them:
--
--   game_uid    UUID - the ClassDiagram types Game.id as `string`, and both the
--               REST API and the Redis cache key use that UUID. `id SERIAL`
--               stays as the surrogate key exactly as the spec wrote it.
--   updated_at  TIMESTAMPTZ - required to satisfy ASR-1 (data durability) and
--               the "game completion rate" / RPO reporting in section G.
--
-- See README -> "Underspecified areas" for the reasoning.

CREATE SCHEMA IF NOT EXISTS game;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Spec section D, verbatim, in the `game` schema, with the extra columns noted
-- above.
CREATE TABLE IF NOT EXISTS game.games (
  id          SERIAL PRIMARY KEY,
  game_uid    UUID NOT NULL DEFAULT gen_random_uuid(),
  game_state  JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT games_game_uid_key UNIQUE (game_uid)
);

-- The repository upserts on game_uid, so that unique constraint is load-bearing.
CREATE UNIQUE INDEX IF NOT EXISTS games_game_uid_idx ON game.games (game_uid);

-- Reporting / leaderboard support. Section G names "game start rate",
-- "game completion rate" and "user engagement" as GameComponent metrics.
CREATE INDEX IF NOT EXISTS games_state_idx ON game.games ((game_state ->> 'state'));
CREATE INDEX IF NOT EXISTS games_score_idx ON game.games (((game_state ->> 'score')::int) DESC);
CREATE INDEX IF NOT EXISTS games_user_idx ON game.games ((game_state -> 'user' ->> 'id'));
CREATE INDEX IF NOT EXISTS games_started_at_idx ON game.games ((game_state ->> 'startedAt'));
CREATE INDEX IF NOT EXISTS games_answers_gin_idx ON game.games USING GIN ((game_state -> 'answers'));

COMMENT ON TABLE game.games IS 'GameComponent game state (FR-1 Play game). Owned exclusively by the GameComponent service.';
COMMENT ON COLUMN game.games.game_state IS 'Serialised domain Game aggregate: id, score, state, user, questions[], answers[], timestamps.';

-- ---------------------------------------------------------------------------
-- ASR-1 (data durability) support, per spec section D/E:
--   "Use PostgreSQL replication for high availability"
--   "Implement regular backups and data replication"
--
-- A standby role that is granted read-only access, used both by the replication
-- verification endpoint (GET /api/v1/durability) and by the DR runbook.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spacefractions_standby') THEN
    CREATE ROLE spacefractions_standby WITH LOGIN REPLICATION;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA game TO spacefractions_standby;
GRANT SELECT ON ALL TABLES IN SCHEMA game TO spacefractions_standby;
ALTER DEFAULT PRIVILEGES IN SCHEMA game GRANT SELECT ON TABLES TO spacefractions_standby;

-- RPO is 1 hour (section G), so an hourly snapshot is the durability baseline.
-- Real deployments drive this from Terraform/Jenkins (section D) via pgBackRest
-- or a managed-provider backup schedule; this records the intent in the schema.
COMMENT ON SCHEMA game IS 'RPO 1h / RTO 1h (spec section G). Hourly snapshots + streaming replication to at least one standby.';
