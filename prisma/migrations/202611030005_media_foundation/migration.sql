-- P2-09A: private asset records and immutable revision references only.
-- No upload/delete HTTP interface, application roles, or historical SQL edits.
BEGIN;

CREATE TYPE "MediaAssetState" AS ENUM ('PENDING', 'READY', 'FAILED', 'DELETING', 'DELETED');

CREATE TABLE "media_asset" (
  "id" UUID NOT NULL,
  "storage_key" UUID NOT NULL DEFAULT gen_random_uuid(),
  "state" "MediaAssetState" NOT NULL DEFAULT 'PENDING',
  "display_mime_type" VARCHAR(32),
  "display_width" INTEGER,
  "display_height" INTEGER,
  "display_bytes" INTEGER,
  "display_sha256" VARCHAR(64),
  "thumbnail_mime_type" VARCHAR(32),
  "thumbnail_width" INTEGER,
  "thumbnail_height" INTEGER,
  "thumbnail_bytes" INTEGER,
  "thumbnail_sha256" VARCHAR(64),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "media_asset_pkey" PRIMARY KEY ("id"),
  -- A record has either no derived metadata or a complete pair of WebP outputs.
  -- Dimensions/input limits belong to processing policy, not frozen DB limits.
  CONSTRAINT "media_asset_metadata_complete" CHECK (
    (
      "display_mime_type" IS NULL AND "display_width" IS NULL AND "display_height" IS NULL
      AND "display_bytes" IS NULL AND "display_sha256" IS NULL
      AND "thumbnail_mime_type" IS NULL AND "thumbnail_width" IS NULL AND "thumbnail_height" IS NULL
      AND "thumbnail_bytes" IS NULL AND "thumbnail_sha256" IS NULL
    ) OR (
      "display_mime_type" = 'image/webp' AND "display_width" > 0 AND "display_height" > 0
      AND "display_bytes" > 0 AND "display_sha256" ~ '^[0-9a-f]{64}$'
      AND "thumbnail_mime_type" = 'image/webp' AND "thumbnail_width" > 0 AND "thumbnail_height" > 0
      AND "thumbnail_bytes" > 0 AND "thumbnail_sha256" ~ '^[0-9a-f]{64}$'
    ) IS TRUE
  ),
  CONSTRAINT "media_asset_state_metadata" CHECK (
    ("state" = 'READY' AND "display_mime_type" IS NOT NULL)
    OR ("state" IN ('PENDING', 'FAILED') AND "display_mime_type" IS NULL)
    OR "state" IN ('DELETING', 'DELETED')
  )
);
CREATE UNIQUE INDEX "media_asset_storage_key_key" ON "media_asset"("storage_key");
CREATE UNIQUE INDEX "media_asset_id_state_key" ON "media_asset"("id", "state");

CREATE TABLE "story_revision_asset" (
  "revision_id" UUID NOT NULL,
  "asset_id" UUID NOT NULL,
  "required_state" "MediaAssetState" NOT NULL DEFAULT 'READY',
  CONSTRAINT "story_revision_asset_pkey" PRIMARY KEY ("revision_id", "asset_id"),
  CONSTRAINT "story_revision_asset_ready_only" CHECK ("required_state" = 'READY'),
  CONSTRAINT "story_revision_asset_revision_id_fkey" FOREIGN KEY ("revision_id")
    REFERENCES "story_revision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- Native FK key locks are the concurrency authority. A READY asset referenced
  -- by ANY retained revision cannot transition to DELETING, even after a newer
  -- revision removes it or the story is withdrawn. No refcount/snapshot race.
  CONSTRAINT "story_revision_asset_asset_id_required_state_fkey" FOREIGN KEY ("asset_id", "required_state")
    REFERENCES "media_asset"("id", "state") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "story_revision_asset_asset_id_required_state_idx"
  ON "story_revision_asset"("asset_id", "required_state");

CREATE FUNCTION mq_guard_media_asset() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Media records retain their stable identity' USING ERRCODE = '23514';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'PENDING' THEN
      RAISE EXCEPTION 'Media assets must start pending' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."storage_key" IS DISTINCT FROM OLD."storage_key"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'Media identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD."state" = 'PENDING' AND NEW."state" IN ('READY', 'FAILED', 'DELETING'))
    OR (OLD."state" IN ('READY', 'FAILED') AND NEW."state" = 'DELETING')
    OR (OLD."state" = 'DELETING' AND NEW."state" = 'DELETED')
  ) THEN
    RAISE EXCEPTION 'Invalid media lifecycle transition' USING ERRCODE = '23514';
  END IF;
  IF NOT (OLD."state" = 'PENDING' AND NEW."state" = 'READY') AND (
    ROW(NEW."display_mime_type", NEW."display_width", NEW."display_height", NEW."display_bytes", NEW."display_sha256",
      NEW."thumbnail_mime_type", NEW."thumbnail_width", NEW."thumbnail_height", NEW."thumbnail_bytes", NEW."thumbnail_sha256")
    IS DISTINCT FROM
    ROW(OLD."display_mime_type", OLD."display_width", OLD."display_height", OLD."display_bytes", OLD."display_sha256",
      OLD."thumbnail_mime_type", OLD."thumbnail_width", OLD."thumbnail_height", OLD."thumbnail_bytes", OLD."thumbnail_sha256")
  ) THEN
    RAISE EXCEPTION 'Derived media metadata is immutable' USING ERRCODE = '23514';
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_asset_guard BEFORE INSERT OR UPDATE OR DELETE ON "media_asset"
FOR EACH ROW EXECUTE FUNCTION mq_guard_media_asset();
CREATE TRIGGER media_asset_no_truncate BEFORE TRUNCATE ON "media_asset"
FOR EACH STATEMENT EXECUTE FUNCTION mq_guard_media_asset();

-- Preserve the v1 envelope exactly, while admitting the separately validated
-- v2 assetId representation. No existing v1 row or historical revision changes.
ALTER TABLE "story_revision" DROP CONSTRAINT "story_revision_content_envelope_check";
ALTER TABLE "story_revision" ADD CONSTRAINT "story_revision_content_envelope_check" CHECK ((
  jsonb_typeof("content") = 'object'
  AND "content" -> 'version' IN ('1'::jsonb, '2'::jsonb)
  AND jsonb_typeof("content" -> 'blocks') = 'array'
) IS TRUE);

CREATE FUNCTION mq_guard_revision_asset() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Revision media references are immutable' USING ERRCODE = '23514';
  END IF;
  -- The projection is the only writer. Membership also rejects unrelated rows
  -- even in a nested trigger; PK uniqueness prevents post-hoc additions for an
  -- already-complete projection. Runtime roles cannot CREATE/TRIGGER or DML.
  IF pg_trigger_depth() <> 2 OR NOT EXISTS (
    SELECT 1 FROM public."story_revision" revision,
      LATERAL jsonb_array_elements(revision."content" -> 'blocks') AS block(value)
    WHERE revision."id" = NEW."revision_id" AND revision."content" -> 'version' = '2'::jsonb
      AND block.value ->> 'type' = 'image'
      AND lower(block.value ->> 'assetId') = NEW."asset_id"::text
  ) THEN
    RAISE EXCEPTION 'Revision media references are generated from content' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revision_asset_guard BEFORE INSERT OR UPDATE OR DELETE ON "story_revision_asset"
FOR EACH ROW EXECUTE FUNCTION mq_guard_revision_asset();
CREATE TRIGGER revision_asset_no_truncate BEFORE TRUNCATE ON "story_revision_asset"
FOR EACH STATEMENT EXECUTE FUNCTION mq_guard_revision_asset();

-- Fixed owner and search_path follow migration004. Only this narrow trigger
-- writes the derived relation; the app never gets relation DML or EXECUTE.
CREATE FUNCTION mq_project_revision_assets() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE block jsonb;
BEGIN
  IF NEW."content" -> 'version' = '1'::jsonb THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(NEW."content") AS key WHERE key NOT IN ('version', 'blocks'))
    OR jsonb_array_length(NEW."content" -> 'blocks') NOT BETWEEN 1 AND 200
    OR octet_length(NEW."content"::text) > 262144 THEN
    RAISE EXCEPTION 'Invalid version 2 content envelope' USING ERRCODE = '23514';
  END IF;
  FOR block IN SELECT value FROM jsonb_array_elements(NEW."content" -> 'blocks') LOOP
    IF jsonb_typeof(block) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Invalid version 2 content block' USING ERRCODE = '23514';
    END IF;
    IF block ->> 'type' = 'paragraph' THEN
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(block) AS key WHERE key NOT IN ('type', 'text', 'style'))
        OR jsonb_typeof(block -> 'text') IS DISTINCT FROM 'string'
        OR length(block ->> 'text') > 10000 OR (block ->> 'text') ~ '^[[:space:]]*$'
        OR (block ? 'style' AND (
          jsonb_typeof(block -> 'style') IS DISTINCT FROM 'string'
          OR block ->> 'style' NOT IN ('normal', 'emphasis', 'strong')
        )) THEN
        RAISE EXCEPTION 'Invalid version 2 paragraph' USING ERRCODE = '23514';
      END IF;
    ELSIF block ->> 'type' = 'image' THEN
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(block) AS key WHERE key NOT IN ('type', 'assetId', 'alt', 'caption'))
        OR jsonb_typeof(block -> 'assetId') IS DISTINCT FROM 'string'
        OR (block ->> 'assetId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(block -> 'alt') IS DISTINCT FROM 'string'
        OR length(block ->> 'alt') > 300 OR (block ->> 'alt') ~ '^[[:space:]]*$'
        OR (block ? 'caption' AND (
          jsonb_typeof(block -> 'caption') IS DISTINCT FROM 'string'
          OR length(block ->> 'caption') > 1000 OR (block ->> 'caption') ~ '^[[:space:]]*$'
        )) THEN
        RAISE EXCEPTION 'Invalid version 2 image' USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'Unsupported version 2 block type' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  INSERT INTO public."story_revision_asset" ("revision_id", "asset_id")
    SELECT NEW."id", (value ->> 'assetId')::uuid
    FROM jsonb_array_elements(NEW."content" -> 'blocks')
    WHERE value ->> 'type' = 'image'
    GROUP BY (value ->> 'assetId')::uuid;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revision_asset_projection AFTER INSERT ON "story_revision"
FOR EACH ROW EXECUTE FUNCTION mq_project_revision_assets();

REVOKE ALL ON "media_asset", "story_revision_asset" FROM PUBLIC;
REVOKE ALL ON FUNCTION mq_guard_media_asset(), mq_guard_revision_asset(), mq_project_revision_assets() FROM PUBLIC;

COMMIT;
