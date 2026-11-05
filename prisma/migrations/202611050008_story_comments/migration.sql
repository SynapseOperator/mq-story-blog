BEGIN;

CREATE TYPE public."CommentState" AS ENUM ('PENDING','APPROVED','REJECTED','WITHDRAWN');
CREATE TABLE public.story_comment (
  id uuid NOT NULL,
  story_id uuid NOT NULL,
  user_id text,
  body text NOT NULL,
  submission_key_hash varchar(64) NOT NULL,
  state public."CommentState" NOT NULL DEFAULT 'PENDING',
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  moderated_at timestamptz(3),
  moderated_by text,
  approved_at timestamptz(3),
  CONSTRAINT story_comment_pkey PRIMARY KEY(id),
  CONSTRAINT story_comment_story_id_fkey FOREIGN KEY(story_id) REFERENCES public.story(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT story_comment_user_id_fkey FOREIGN KEY(user_id) REFERENCES public."User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT story_comment_moderated_by_fkey FOREIGN KEY(moderated_by) REFERENCES public."User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT story_comment_body_length CHECK(char_length(body) BETWEEN 1 AND 500),
  CONSTRAINT story_comment_key_hash CHECK(submission_key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT story_comment_version CHECK(version>=0)
);
CREATE UNIQUE INDEX story_comment_submission_key_hash_key ON public.story_comment(submission_key_hash);
CREATE INDEX story_comment_story_id_state_created_at_id_idx ON public.story_comment(story_id,state,created_at,id);
CREATE INDEX story_comment_state_created_at_id_idx ON public.story_comment(state,created_at,id);
REVOKE ALL ON public.story_comment FROM PUBLIC;

-- Identity/session locks precede the story lock, matching withAdmin and likes.
-- Anonymous submissions use NULL/NULL. Returning state lets moderation remove
-- unsafe comments after withdrawal without exposing hidden stories publicly.
CREATE FUNCTION public.mq_lock_comment_context(expected_session text,expected_user text,target_story uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE expiry timestamp; selected_state public."StoryState";
BEGIN
  IF (expected_session IS NULL) <> (expected_user IS NULL) THEN RETURN 'unauthenticated'; END IF;
  IF expected_user IS NOT NULL THEN
    PERFORM 1 FROM public."User" WHERE id=expected_user FOR SHARE;
    IF NOT FOUND THEN RETURN 'unauthenticated'; END IF;
    SELECT "expiresAt" INTO expiry FROM public."Session"
      WHERE id=expected_session AND "userId"=expected_user FOR SHARE;
    IF NOT FOUND OR expiry <= (clock_timestamp() AT TIME ZONE 'UTC') THEN RETURN 'unauthenticated'; END IF;
  END IF;
  SELECT state INTO selected_state FROM public.story WHERE id=target_story FOR SHARE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF expected_user IS NOT NULL AND expiry <= (clock_timestamp() AT TIME ZONE 'UTC') THEN RETURN 'unauthenticated'; END IF;
  RETURN selected_state::text;
END;
$$;

-- The fixed trigger needs row-lock privileges, not the application identity.
-- It also protects direct SQL INSERT: defaults/column grants alone do not prove
-- the story is still public when the submission commits.
CREATE FUNCTION public.mq_guard_story_comment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected_state public."StoryState";
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Comment removal is unavailable' USING ERRCODE='P7205';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'PENDING' OR NEW.version<>0 OR NEW.moderated_at IS NOT NULL
      OR NEW.moderated_by IS NOT NULL OR NEW.approved_at IS NOT NULL
      OR char_length(NEW.body) NOT BETWEEN 1 AND 500 OR btrim(NEW.body,E' \n\r\t')='' THEN
      RAISE EXCEPTION 'Comment input rejected' USING ERRCODE='P7200';
    END IF;
    SELECT state INTO selected_state FROM public.story WHERE id=NEW.story_id FOR SHARE;
    IF NOT FOUND OR selected_state<>'PUBLISHED' THEN
      RAISE EXCEPTION 'Story unavailable' USING ERRCODE='P7204';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.story_id IS DISTINCT FROM OLD.story_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.body IS DISTINCT FROM OLD.body
    OR NEW.submission_key_hash IS DISTINCT FROM OLD.submission_key_hash OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Comment identity is immutable' USING ERRCODE='P7200';
  END IF;
  IF OLD.version=2147483647 OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'Comment changed' USING ERRCODE='P7203';
  END IF;
  IF NOT ((OLD.state='PENDING' AND NEW.state IN ('APPROVED','REJECTED'))
    OR (OLD.state='APPROVED' AND NEW.state='WITHDRAWN')) THEN
    RAISE EXCEPTION 'Comment transition rejected' USING ERRCODE='P7205';
  END IF;
  IF NEW.moderated_at IS NULL OR NEW.moderated_by IS NULL
    OR (NEW.state='APPROVED' AND NEW.approved_at IS NULL)
    OR (NEW.state<>'APPROVED' AND NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'Comment review metadata rejected' USING ERRCODE='P7200';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER story_comment_guard BEFORE INSERT OR UPDATE OR DELETE ON public.story_comment
FOR EACH ROW EXECUTE FUNCTION public.mq_guard_story_comment();
CREATE TRIGGER story_comment_no_truncate BEFORE TRUNCATE ON public.story_comment
FOR EACH STATEMENT EXECUTE FUNCTION public.mq_guard_story_comment();

CREATE SCHEMA mq_comment_private;
REVOKE ALL ON SCHEMA mq_comment_private FROM PUBLIC;
CREATE TABLE mq_comment_private.moderation_key (
  id integer PRIMARY KEY CHECK(id=1),
  secret bytea NOT NULL CHECK(octet_length(secret)=32)
);
REVOKE ALL ON mq_comment_private.moderation_key FROM PUBLIC;

-- No key material or runtime grants in migration SQL. Explicit provisioning
-- installs an independent NOLOGIN owner; restored migration ownership rejects.
CREATE FUNCTION public.mq_apply_comment_moderation(payload text,signature bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE parts jsonb; secret_key bytea; calculated bytea; difference integer:=0; i integer;
  action text; target_story uuid; target_comment uuid; expected integer; context text;
  selected record; reviewed_at timestamptz;
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=current_user
      AND (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication))
    OR pg_catalog.pg_has_role(current_user,(SELECT datdba FROM pg_catalog.pg_database WHERE datname=current_database()),'MEMBER') THEN
    RAISE EXCEPTION 'Moderation configuration unavailable' USING ERRCODE='P7202';
  END IF;
  IF payload IS NULL OR octet_length(payload)>4096 OR signature IS NULL OR octet_length(signature)<>32 THEN
    RAISE EXCEPTION 'Moderation proof rejected' USING ERRCODE='P7201';
  END IF;
  BEGIN parts:=payload::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Moderation proof rejected' USING ERRCODE='P7201';
  END;
  IF jsonb_typeof(parts) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Moderation proof rejected' USING ERRCODE='P7201';
  END IF;
  IF jsonb_array_length(parts)<>10 OR EXISTS(SELECT 1 FROM jsonb_array_elements(parts) p WHERE jsonb_typeof(p)<>'string')
    OR parts->>0 IS DISTINCT FROM 'mq-comment-moderation-v1'
    OR parts->>1 IS DISTINCT FROM current_database() OR parts->>2 IS DISTINCT FROM session_user
    OR parts->>3 IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'Moderation proof rejected' USING ERRCODE='P7201';
  END IF;
  SELECT secret INTO secret_key FROM mq_comment_private.moderation_key WHERE id=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Moderation configuration unavailable' USING ERRCODE='P7202'; END IF;
  calculated:=mq_publish_private.hmac(convert_to(payload,'UTF8'),secret_key,'sha256');
  FOR i IN 0..31 LOOP difference:=difference | (get_byte(calculated,i) # get_byte(signature,i)); END LOOP;
  IF difference<>0 OR NOT public.mq_lock_admin_access(parts->>4,parts->>5) THEN
    RAISE EXCEPTION 'Moderation proof rejected' USING ERRCODE='P7201';
  END IF;
  action:=parts->>6;
  IF action NOT IN ('approve','reject','withdraw')
    OR (parts->>7)!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR (parts->>8)!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR (parts->>9)!~'^(0|[1-9][0-9]{0,9})$' OR (parts->>9)::bigint>=2147483647 THEN
    RAISE EXCEPTION 'Moderation input rejected' USING ERRCODE='P7200';
  END IF;
  target_story:=(parts->>7)::uuid; target_comment:=(parts->>8)::uuid; expected:=(parts->>9)::integer;
  context:=public.mq_lock_comment_context(parts->>4,parts->>5,target_story);
  IF context='unauthenticated' THEN RAISE EXCEPTION 'Moderation proof rejected' USING ERRCODE='P7201'; END IF;
  IF context='not_found' THEN RAISE EXCEPTION 'Comment unavailable' USING ERRCODE='P7204'; END IF;
  IF action='approve' AND context<>'PUBLISHED' THEN
    RAISE EXCEPTION 'Story unavailable' USING ERRCODE='P7204';
  END IF;
  SELECT id,story_id,state,version,approved_at INTO selected FROM public.story_comment
    WHERE id=target_comment AND story_id=target_story FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Comment unavailable' USING ERRCODE='P7204'; END IF;
  -- The comment row may have been busy until after this session expired. All
  -- authorization rows are already locked, so this recheck adds no lock order.
  IF NOT public.mq_lock_admin_access(parts->>4,parts->>5) THEN
    RAISE EXCEPTION 'Moderation proof rejected' USING ERRCODE='P7201';
  END IF;
  IF selected.version<>expected THEN RAISE EXCEPTION 'Comment changed' USING ERRCODE='P7203'; END IF;
  IF (action IN ('approve','reject') AND selected.state<>'PENDING')
    OR (action='withdraw' AND selected.state<>'APPROVED') THEN
    RAISE EXCEPTION 'Comment transition rejected' USING ERRCODE='P7205';
  END IF;
  reviewed_at:=clock_timestamp();
  UPDATE public.story_comment SET
    state=CASE action WHEN 'approve' THEN 'APPROVED'::public."CommentState"
      WHEN 'reject' THEN 'REJECTED'::public."CommentState" ELSE 'WITHDRAWN'::public."CommentState" END,
    version=version+1,moderated_by=parts->>5,moderated_at=reviewed_at,
    approved_at=CASE WHEN action='approve' THEN reviewed_at ELSE selected.approved_at END
    WHERE id=selected.id AND version=expected AND state=selected.state;
  IF NOT FOUND THEN RAISE EXCEPTION 'Comment changed' USING ERRCODE='P7203'; END IF;
  RETURN selected.id;
END;
$$;
REVOKE ALL ON FUNCTION public.mq_lock_comment_context(text,text,uuid),public.mq_guard_story_comment(),
  public.mq_apply_comment_moderation(text,bytea) FROM PUBLIC;
COMMIT;
