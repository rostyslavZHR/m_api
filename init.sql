CREATE ROLE app_user LOGIN PASSWORD 'app-v1-password';

GRANT CONNECT ON DATABASE shop TO app_user;

-- The tables don't exist yet: migrations create them later, running as admin.
-- Default privileges attach these grants to every table and sequence admin
-- creates from now on. app_user gets data access only, never DDL.
ALTER DEFAULT PRIVILEGES FOR ROLE admin IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE admin IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO app_user;

-- PgBouncer looks login passwords up in Postgres (auth_query) instead of keeping
-- a copy in its userlist, so rotating app_user's password needs no PgBouncer step.
-- pgbouncer_auth can do exactly one thing: call get_auth(). The function runs
-- with its owner's rights (SECURITY DEFINER, owned by the superuser running this
-- file), so it can read pg_authid, which only superusers can. It returns one
-- login role's SCRAM secret, and never a superuser's. Like PgBouncer's default
-- auth_query, it returns NULL for a password past its VALID UNTIL: PgBouncer
-- may hand the client an already-open server connection, so Postgres never
-- gets the chance to reject the expired password itself.
CREATE ROLE pgbouncer_auth LOGIN PASSWORD 'pgbouncer-auth-dev-only';

CREATE SCHEMA pgbouncer;
CREATE FUNCTION pgbouncer.get_auth(p_usename text)
RETURNS TABLE (usename name, passwd text)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT rolname, CASE WHEN rolvaliduntil < now() THEN NULL ELSE rolpassword END
  FROM pg_authid
  WHERE rolname = p_usename AND rolcanlogin AND NOT rolsuper
$$;

REVOKE ALL ON FUNCTION pgbouncer.get_auth(text) FROM PUBLIC;
GRANT USAGE ON SCHEMA pgbouncer TO pgbouncer_auth;
GRANT EXECUTE ON FUNCTION pgbouncer.get_auth(text) TO pgbouncer_auth;
