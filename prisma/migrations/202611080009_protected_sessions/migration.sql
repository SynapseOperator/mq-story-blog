-- Deploy in a stopped-write maintenance window with the new independent key.
-- Old cookies must require a fresh password login. Accounts and business data
-- are retained; there is deliberately no raw-token / ciphertext dual-read.
BEGIN;
LOCK TABLE "Session" IN ACCESS EXCLUSIVE MODE;
DELETE FROM "Session";
ALTER TABLE "Session" ADD COLUMN "tokenCiphertext" TEXT NOT NULL;
ALTER TABLE "Session" ADD CONSTRAINT "session_lookup_format"
  CHECK ("token" ~ '^hmac1:[0-9a-f]{64}$');
ALTER TABLE "Session" ADD CONSTRAINT "session_ciphertext_format"
  CHECK ("tokenCiphertext" ~ '^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]{64}$');
-- Cryptographic authenticity is verified by the application, never by a DB
-- secret or SECURITY DEFINER owner. No runtime UPDATE privilege is added.
COMMIT;
