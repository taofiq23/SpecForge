-- Space Fractions - bootstrap
--
-- Runs first (docker-entrypoint-initdb.d/00-bootstrap.sql) so the per-component
-- DDL files can assume their schemas exist. Mirrors the postgres-init-ddl
-- ConfigMap in k8s/spacefractions-deployment.yaml.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS game;
CREATE SCHEMA IF NOT EXISTS question;
CREATE SCHEMA IF NOT EXISTS user_svc;

-- Read replica role used for the ASR-1 replication verification endpoint.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spacefractions_standby') THEN
    CREATE ROLE spacefractions_standby WITH LOGIN REPLICATION;
  END IF;
END
$$;
