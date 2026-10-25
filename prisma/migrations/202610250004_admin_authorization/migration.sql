BEGIN;

CREATE TABLE "AdminGrant" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "userId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "credentialVersion" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMPTZ(3),
  CONSTRAINT "AdminGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_singleton_identity" CHECK ("id" = 1),
  CONSTRAINT "admin_nonnegative_versions" CHECK ("version" >= 0 AND "credentialVersion" >= 0),
  CONSTRAINT "AdminGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "AdminGrant_userId_key" ON "AdminGrant"("userId");

CREATE TABLE "AdminSecurityEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "kind" VARCHAR(32) NOT NULL,
  "userId" TEXT NOT NULL,
  "eventAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "databaseActor" TEXT NOT NULL,
  CONSTRAINT "AdminSecurityEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_security_event_kind" CHECK ("kind" IN ('GRANTED', 'REVOKED', 'RESTORED', 'CREDENTIAL_RESET')),
  CONSTRAINT "AdminSecurityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "AdminSecurityEvent_userId_eventAt_idx" ON "AdminSecurityEvent"("userId", "eventAt");

CREATE FUNCTION mq_guard_admin_grant() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Administrator identity must be retained' USING ERRCODE = '23514';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW."version" <> 0 OR NEW."credentialVersion" <> 0 OR NEW."revokedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid initial administrator state' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'Invalid administrator identity or version' USING ERRCODE = '23514';
  END IF;
  IF (OLD."revokedAt" IS NULL) <> (NEW."revokedAt" IS NULL)
    AND NEW."credentialVersion" = OLD."credentialVersion" THEN
    RETURN NEW;
  END IF;
  -- Only the installed credential trigger may advance a same-state version.
  -- Application/maintenance roles have neither CREATE nor TRIGGER privileges.
  IF pg_trigger_depth() > 1 AND NEW."revokedAt" IS NOT DISTINCT FROM OLD."revokedAt"
    AND NEW."credentialVersion" = OLD."credentialVersion" + 1 THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Invalid administrator state transition' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER admin_grant_guard BEFORE INSERT OR UPDATE OR DELETE ON "AdminGrant"
FOR EACH ROW EXECUTE FUNCTION mq_guard_admin_grant();
CREATE TRIGGER admin_grant_no_truncate BEFORE TRUNCATE ON "AdminGrant"
FOR EACH STATEMENT EXECUTE FUNCTION mq_guard_admin_grant();

CREATE FUNCTION mq_admin_grant_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE event_kind text;
BEGIN
  IF TG_OP = 'INSERT' THEN event_kind := 'GRANTED';
  ELSIF NEW."credentialVersion" <> OLD."credentialVersion" THEN event_kind := 'CREDENTIAL_RESET';
  ELSIF NEW."revokedAt" IS NOT NULL THEN event_kind := 'REVOKED';
  ELSE event_kind := 'RESTORED';
  END IF;
  -- Grant/revoke/restore/reset cannot leave a previously issued session alive.
  DELETE FROM public."Session" WHERE "userId" = NEW."userId";
  INSERT INTO public."AdminSecurityEvent" ("kind", "userId", "databaseActor")
    VALUES (event_kind, NEW."userId", session_user);
  RETURN NEW;
END;
$$;
CREATE TRIGGER admin_grant_audit AFTER INSERT OR UPDATE ON "AdminGrant"
FOR EACH ROW EXECUTE FUNCTION mq_admin_grant_audit();

CREATE FUNCTION mq_guard_admin_security_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Administrator security audit is append only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER admin_security_event_immutable BEFORE UPDATE OR DELETE ON "AdminSecurityEvent"
FOR EACH ROW EXECUTE FUNCTION mq_guard_admin_security_event();
CREATE TRIGGER admin_security_event_no_truncate BEFORE TRUNCATE ON "AdminSecurityEvent"
FOR EACH STATEMENT EXECUTE FUNCTION mq_guard_admin_security_event();

CREATE FUNCTION mq_admin_credential_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW."password" IS DISTINCT FROM OLD."password" THEN
    PERFORM 1 FROM public."AdminGrant" WHERE "userId" = OLD."userId" FOR UPDATE;
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION mq_admin_credential_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW."password" IS DISTINCT FROM OLD."password" THEN
    UPDATE public."AdminGrant" SET "version" = "version" + 1, "credentialVersion" = "credentialVersion" + 1
      WHERE "userId" = NEW."userId";
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER admin_credential_lock BEFORE UPDATE OF "password" ON "Account"
FOR EACH ROW EXECUTE FUNCTION mq_admin_credential_lock();
CREATE TRIGGER admin_credential_audit AFTER UPDATE OF "password" ON "Account"
FOR EACH ROW EXECUTE FUNCTION mq_admin_credential_audit();

-- The application only has EXECUTE on this narrow function, never UPDATE on
-- AdminGrant. SELECT FOR SHARE itself requires UPDATE privileges, so the fixed
-- function owner acquires locks; the signed-cookie check remains in Better Auth.
-- Always call inside the protected operation's transaction, not as a detached
-- check. Row locks serialize successful operations against revocation/reset.
CREATE FUNCTION mq_lock_admin_access(expected_session text, expected_user text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE grant_revoked timestamptz; session_expiry timestamp;
BEGIN
  SELECT "revokedAt" INTO grant_revoked FROM public."AdminGrant"
    WHERE "id" = 1 AND "userId" = expected_user FOR SHARE;
  IF NOT FOUND OR grant_revoked IS NOT NULL THEN RETURN false; END IF;
  PERFORM 1 FROM public."User" WHERE "id" = expected_user FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT "expiresAt" INTO session_expiry FROM public."Session"
    WHERE "id" = expected_session AND "userId" = expected_user FOR SHARE;
  IF NOT FOUND OR session_expiry <= (clock_timestamp() AT TIME ZONE 'UTC') THEN RETURN false; END IF;
  RETURN true;
END;
$$;

-- A password login for the dedicated account must hold this lock through
-- verification AND Session creation. Otherwise an in-flight old-password login
-- could create a fresh Session after credential reset has deleted the old ones.
-- Revoked grants are locked too: revocation must never weaken reset ordering.
-- This function neither grants authority nor verifies a password/session.
CREATE FUNCTION mq_lock_admin_credentials(expected_user text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM public."AdminGrant" WHERE "id" = 1 AND "userId" = expected_user FOR SHARE;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON "AdminGrant", "AdminSecurityEvent" FROM PUBLIC;
REVOKE ALL ON FUNCTION mq_guard_admin_grant(), mq_admin_grant_audit(), mq_guard_admin_security_event(),
  mq_admin_credential_lock(), mq_admin_credential_audit(), mq_lock_admin_access(text, text),
  mq_lock_admin_credentials(text) FROM PUBLIC;

COMMIT;
