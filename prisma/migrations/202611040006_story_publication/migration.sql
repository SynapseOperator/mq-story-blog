-- P2-10A: no key material, runtime grants or global roles in migrations.
-- An explicit isolated provisioner replaces the function owner with a narrow
-- NOLOGIN identity before granting EXECUTE. The migration owner cannot use it.
BEGIN;

CREATE SCHEMA mq_publish_private;
REVOKE ALL ON SCHEMA mq_publish_private FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA mq_publish_private;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n
    ON n.oid=e.extnamespace WHERE e.extname='pgcrypto' AND n.nspname='mq_publish_private') THEN
    RAISE EXCEPTION 'Publishing crypto schema requires explicit review';
  END IF;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA mq_publish_private FROM PUBLIC;

CREATE TABLE mq_publish_private.signing_key (
  id integer PRIMARY KEY CHECK (id=1),
  secret bytea NOT NULL CHECK (octet_length(secret)=32)
);
REVOKE ALL ON mq_publish_private.signing_key FROM PUBLIC;

CREATE FUNCTION public.mq_apply_story_publication(payload text, signature bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  parts jsonb; secret_key bytea; calculated bytea; difference integer:=0; i integer;
  selected public.story%ROWTYPE; revision_content jsonb; action text;
  target_id uuid; target_revision uuid; desired_slot text; expected integer;
BEGIN
  -- Function ownership is part of the deployment contract, not an implicit
  -- permission elevation to the migration owner or a login-capable identity.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=current_user
      AND (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication))
    OR pg_catalog.pg_has_role(current_user,
      (SELECT datdba FROM pg_catalog.pg_database WHERE datname=current_database()),'MEMBER') THEN
    RAISE EXCEPTION 'Publication configuration unavailable' USING ERRCODE='P7102';
  END IF;
  IF payload IS NULL OR octet_length(payload)>4096 OR signature IS NULL OR octet_length(signature)<>32 THEN
    RAISE EXCEPTION 'Publication proof rejected' USING ERRCODE='P7101';
  END IF;
  BEGIN parts:=payload::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Publication proof rejected' USING ERRCODE='P7101';
  END;
  IF jsonb_typeof(parts) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Publication proof rejected' USING ERRCODE='P7101';
  END IF;
  IF jsonb_array_length(parts)<>11 OR EXISTS(SELECT 1 FROM jsonb_array_elements(parts) p WHERE jsonb_typeof(p)<>'string')
    OR parts->>0 IS DISTINCT FROM 'mq-publish-v1'
    OR parts->>1 IS DISTINCT FROM current_database()
    OR parts->>2 IS DISTINCT FROM session_user
    OR parts->>3 IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'Publication proof rejected' USING ERRCODE='P7101';
  END IF;
  SELECT secret INTO secret_key FROM mq_publish_private.signing_key WHERE id=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Publication configuration unavailable' USING ERRCODE='P7102'; END IF;
  calculated:=mq_publish_private.hmac(convert_to(payload,'UTF8'),secret_key,'sha256');
  FOR i IN 0..31 LOOP difference:=difference | (get_byte(calculated,i) # get_byte(signature,i)); END LOOP;
  IF difference<>0 OR NOT public.mq_lock_admin_access(parts->>4,parts->>5) THEN
    RAISE EXCEPTION 'Publication proof rejected' USING ERRCODE='P7101';
  END IF;
  action:=parts->>6;
  IF action NOT IN ('slot','publish','withdraw','restore')
    OR (parts->>7)!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR (parts->>8)!~'^(0|[1-9][0-9]{0,9})$' OR (parts->>8)::bigint>=2147483647
    OR ((parts->>9)<>'' AND (parts->>9)!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR ((parts->>10)<>'' AND (parts->>10)!~'^[a-z0-9-]{1,64}$') THEN
    RAISE EXCEPTION 'Publication input rejected' USING ERRCODE='P7100';
  END IF;
  target_id:=(parts->>7)::uuid; expected:=(parts->>8)::integer;
  target_revision:=nullif(parts->>9,'')::uuid; desired_slot:=nullif(parts->>10,'');
  SELECT * INTO selected FROM public.story WHERE id=target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Story unavailable' USING ERRCODE='P7104'; END IF;
  IF selected.version<>expected THEN RAISE EXCEPTION 'Story changed' USING ERRCODE='P7103'; END IF;

  IF action='slot' THEN
    IF selected.kind<>'STAR' OR selected.state<>'DRAFT' OR selected.published_revision_id IS NOT NULL
      OR target_revision IS NOT NULL THEN
      RAISE EXCEPTION 'Publication transition rejected' USING ERRCODE='P7105';
    END IF;
    IF desired_slot IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.star_slot WHERE id=desired_slot) THEN
      RAISE EXCEPTION 'Star slot unavailable' USING ERRCODE='P7100';
    END IF;
  ELSE
    IF desired_slot IS DISTINCT FROM selected.slot_id THEN
      RAISE EXCEPTION 'Story changed' USING ERRCODE='P7103';
    END IF;
    IF action='publish' THEN
      IF selected.state NOT IN ('DRAFT','PUBLISHED') OR (selected.kind='STAR' AND selected.slot_id IS NULL)
        OR selected.draft_revision_id IS NOT DISTINCT FROM selected.published_revision_id THEN
        RAISE EXCEPTION 'Publication transition rejected' USING ERRCODE='P7105';
      END IF;
      IF target_revision IS DISTINCT FROM selected.draft_revision_id THEN
        RAISE EXCEPTION 'Story changed' USING ERRCODE='P7103';
      END IF;
    ELSE
      IF (action='withdraw' AND selected.state<>'PUBLISHED') OR (action='restore' AND selected.state<>'WITHDRAWN') THEN
        RAISE EXCEPTION 'Publication transition rejected' USING ERRCODE='P7105';
      END IF;
      IF target_revision IS DISTINCT FROM selected.published_revision_id THEN
        RAISE EXCEPTION 'Story changed' USING ERRCODE='P7103';
      END IF;
    END IF;
    SELECT content INTO revision_content FROM public.story_revision
      WHERE id=target_revision AND story_id=selected.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Story revision unavailable' USING ERRCODE='P7100'; END IF;
    -- Withdraw must remain possible if storage is damaged. The immutable 005
    -- references and READY foreign key protect this final DB-side check.
    IF action IN ('publish','restore') AND revision_content->'version'='2'::jsonb THEN
      IF EXISTS (
        (SELECT DISTINCT (b->>'assetId')::uuid FROM jsonb_array_elements(revision_content->'blocks') b
          WHERE b->>'type'='image'
         EXCEPT SELECT asset_id FROM public.story_revision_asset WHERE revision_id=target_revision)
        UNION ALL
        (SELECT asset_id FROM public.story_revision_asset WHERE revision_id=target_revision
         EXCEPT SELECT DISTINCT (b->>'assetId')::uuid FROM jsonb_array_elements(revision_content->'blocks') b WHERE b->>'type'='image')
      ) OR EXISTS (SELECT 1 FROM public.story_revision_asset r LEFT JOIN public.media_asset a ON a.id=r.asset_id
        WHERE r.revision_id=target_revision AND (a.id IS NULL OR a.state<>'READY' OR r.required_state<>'READY')) THEN
        RAISE EXCEPTION 'Publication media unavailable' USING ERRCODE='P7106';
      END IF;
    END IF;
  END IF;

  UPDATE public.story SET
    slot_id=CASE WHEN action='slot' THEN desired_slot ELSE selected.slot_id END,
    state=CASE WHEN action='withdraw' THEN 'WITHDRAWN'::public."StoryState"
      WHEN action IN ('publish','restore') THEN 'PUBLISHED'::public."StoryState" ELSE selected.state END,
    published_revision_id=CASE WHEN action='publish' THEN target_revision ELSE selected.published_revision_id END,
    version=version+1,updated_at=CURRENT_TIMESTAMP
    WHERE id=selected.id AND version=expected AND state=selected.state;
  IF NOT FOUND THEN RAISE EXCEPTION 'Story changed' USING ERRCODE='P7103'; END IF;
  RETURN selected.id;
END;
$$;
REVOKE ALL ON FUNCTION public.mq_apply_story_publication(text,bytea) FROM PUBLIC;
COMMIT;
