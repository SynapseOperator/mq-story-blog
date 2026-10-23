-- P2-03: new business tables only. Never rewrite the applied foundation migration.
-- DDL was reviewed against Prisma migrate diff; the marked native constraints
-- below are intentionally maintained in SQL (no Prisma preview features).
BEGIN;

CREATE TYPE "StoryKind" AS ENUM ('STAR', 'CAMPFIRE');
CREATE TYPE "StoryState" AS ENUM ('DRAFT', 'PUBLISHED', 'WITHDRAWN');

CREATE TABLE "star_slot" (
    "id" VARCHAR(64) NOT NULL,
    "scene_key" VARCHAR(64) NOT NULL,
    CONSTRAINT "star_slot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "story" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "kind" "StoryKind" NOT NULL,
    "state" "StoryState" NOT NULL DEFAULT 'DRAFT',
    "slot_id" VARCHAR(64),
    "draft_revision_id" UUID NOT NULL,
    "published_revision_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "story_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "story_slug_format_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    CONSTRAINT "story_version_check" CHECK ("version" >= 0),
    CONSTRAINT "story_kind_slot_check" CHECK (
        ("kind" = 'CAMPFIRE' AND "slot_id" IS NULL)
        OR ("kind" = 'STAR' AND ("state" = 'DRAFT' OR "slot_id" IS NOT NULL))
    ),
    CONSTRAINT "story_publication_state_check" CHECK (
        ("state" = 'DRAFT' AND "published_revision_id" IS NULL)
        OR ("state" IN ('PUBLISHED', 'WITHDRAWN') AND "published_revision_id" IS NOT NULL)
    )
);

CREATE TABLE "story_revision" (
    "id" UUID NOT NULL,
    "story_id" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "content" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "story_revision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "story_revision_title_check" CHECK (length(btrim("title")) > 0),
    -- Basic storage envelope only; the domain service validates allowed blocks,
    -- text lengths, inline formatting, and safe image locations in full.
    -- IS TRUE also rejects missing keys: PostgreSQL CHECK otherwise accepts NULL.
    CONSTRAINT "story_revision_content_envelope_check" CHECK ((
        jsonb_typeof("content") = 'object'
        AND "content" -> 'version' = '1'::jsonb
        AND jsonb_typeof("content" -> 'blocks') = 'array'
    ) IS TRUE)
);

CREATE UNIQUE INDEX "star_slot_scene_key_key" ON "star_slot"("scene_key");
CREATE UNIQUE INDEX "story_slug_key" ON "story"("slug");
-- Applies to every lifecycle state, including reserved drafts and withdrawals.
CREATE UNIQUE INDEX "story_slot_id_key" ON "story"("slot_id");
CREATE UNIQUE INDEX "story_revision_story_id_id_key" ON "story_revision"("story_id", "id");
-- Native partial uniqueness: many STAR stories, at most one CAMPFIRE story,
-- including an unpublished draft or a withdrawn campfire. No ordinary slot used.
CREATE UNIQUE INDEX "story_single_campfire_key" ON "story"("kind") WHERE "kind" = 'CAMPFIRE';

ALTER TABLE "story" ADD CONSTRAINT "story_slot_id_fkey"
    FOREIGN KEY ("slot_id") REFERENCES "star_slot"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Composite ownership prevents a story from pointing at another story's content.
-- Deferral permits inserting Story followed by its first Revision atomically;
-- neither an absent draft nor a cross-story pointer may survive transaction commit.
ALTER TABLE "story" ADD CONSTRAINT "story_id_draft_revision_id_fkey"
    FOREIGN KEY ("id", "draft_revision_id") REFERENCES "story_revision"("story_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "story" ADD CONSTRAINT "story_id_published_revision_id_fkey"
    FOREIGN KEY ("id", "published_revision_id") REFERENCES "story_revision"("story_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "story_revision" ADD CONSTRAINT "story_revision_story_id_fkey"
    FOREIGN KEY ("story_id") REFERENCES "story"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A revision is append-only, so editing a draft cannot mutate a public snapshot.
-- Retention/deletion is deliberately not a P2-03 capability.
CREATE FUNCTION "mq_reject_revision_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Story revisions are immutable; append a new revision instead'
        USING ERRCODE = '23514', CONSTRAINT = 'story_revision_immutable';
END;
$$;
CREATE TRIGGER "story_revision_immutable"
    BEFORE UPDATE OR DELETE ON "story_revision"
    FOR EACH ROW EXECUTE FUNCTION "mq_reject_revision_mutation"();

-- Slot identities and their accepted scene mappings never move. New slots may
-- be inserted later; these three rows do not set the final number of stars.
CREATE FUNCTION "mq_reject_slot_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Star slot identities and scene mappings are immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'star_slot_immutable';
END;
$$;
CREATE TRIGGER "star_slot_immutable"
    BEFORE UPDATE OR DELETE ON "star_slot"
    FOR EACH ROW EXECUTE FUNCTION "mq_reject_slot_mutation"();

-- SQL guards preserve invariants even if a future caller bypasses the service.
-- The service additionally requires the editor's expected version in its CAS
-- UPDATE predicate; this trigger does not replace that optimistic-lock check.
CREATE FUNCTION "mq_guard_story_lifecycle"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."state" <> 'DRAFT' OR NEW."version" <> 0 THEN
            RAISE EXCEPTION 'New stories must start as draft at version zero'
                USING ERRCODE = '23514', CONSTRAINT = 'story_initial_state';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."slug" IS DISTINCT FROM OLD."slug"
        OR NEW."kind" IS DISTINCT FROM OLD."kind" THEN
        RAISE EXCEPTION 'Story identity, slug, and kind are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'story_identity_immutable';
    END IF;
    IF NEW."version" <> OLD."version" + 1 THEN
        RAISE EXCEPTION 'Every story mutation must increment its version by one'
            USING ERRCODE = '23514', CONSTRAINT = 'story_version_increment';
    END IF;
    IF OLD."published_revision_id" IS NOT NULL AND NEW."slot_id" IS DISTINCT FROM OLD."slot_id" THEN
        RAISE EXCEPTION 'A previously published story must retain its slot'
            USING ERRCODE = '23514', CONSTRAINT = 'story_published_slot_immutable';
    END IF;
    IF NOT (
        NEW."state" = OLD."state"
        OR (OLD."state" = 'DRAFT' AND NEW."state" = 'PUBLISHED')
        OR (OLD."state" = 'PUBLISHED' AND NEW."state" = 'WITHDRAWN')
        OR (OLD."state" = 'WITHDRAWN' AND NEW."state" = 'PUBLISHED')
    ) THEN
        RAISE EXCEPTION 'Illegal story lifecycle transition'
            USING ERRCODE = '23514', CONSTRAINT = 'story_state_transition';
    END IF;

    IF OLD."state" = 'DRAFT' AND NEW."state" = 'PUBLISHED' THEN
        IF NEW."published_revision_id" IS DISTINCT FROM NEW."draft_revision_id" THEN
            RAISE EXCEPTION 'First publication must publish the current draft'
                USING ERRCODE = '23514', CONSTRAINT = 'story_publish_current_draft';
        END IF;
    ELSIF OLD."state" = 'PUBLISHED' AND NEW."state" = 'PUBLISHED'
        AND NEW."published_revision_id" IS DISTINCT FROM OLD."published_revision_id" THEN
        IF NEW."published_revision_id" IS DISTINCT FROM NEW."draft_revision_id" THEN
            RAISE EXCEPTION 'A publication update must publish the current draft'
                USING ERRCODE = '23514', CONSTRAINT = 'story_publish_current_draft';
        END IF;
    ELSIF NEW."published_revision_id" IS DISTINCT FROM OLD."published_revision_id" THEN
        RAISE EXCEPTION 'Withdrawal and restoration must retain the public revision'
            USING ERRCODE = '23514', CONSTRAINT = 'story_public_revision_preserved';
    END IF;

    NEW."updated_at" := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "story_lifecycle_guard"
    BEFORE INSERT OR UPDATE ON "story"
    FOR EACH ROW EXECUTE FUNCTION "mq_guard_story_lifecycle"();

-- Only stable visual metadata is seeded, never stories, photos, or users.
INSERT INTO "star_slot" ("id", "scene_key") VALUES
    ('star-1', 'story-position--1'),
    ('star-2', 'story-position--2'),
    ('star-3', 'story-position--3');

COMMIT;
