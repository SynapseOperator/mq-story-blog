BEGIN;

CREATE TABLE public.story_like (
  user_id text NOT NULL,
  story_id uuid NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT story_like_pkey PRIMARY KEY (user_id, story_id),
  CONSTRAINT story_like_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT story_like_story_id_fkey FOREIGN KEY (story_id) REFERENCES public.story(id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX story_like_story_id_idx ON public.story_like(story_id);
REVOKE ALL ON public.story_like FROM PUBLIC;

-- Like writes need row locks without giving the runtime UPDATE on Session or
-- publication fields. Match the existing authorization lock order. The caller
-- verifies the signed cookie first and must mutate/count in this transaction.
CREATE FUNCTION public.mq_lock_story_like_access(expected_session text, expected_user text, target_story uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE session_expiry timestamp; story_state public."StoryState";
BEGIN
  PERFORM 1 FROM public."User" WHERE id=expected_user FOR SHARE;
  IF NOT FOUND THEN RETURN 'unauthenticated'; END IF;
  SELECT "expiresAt" INTO session_expiry FROM public."Session"
    WHERE id=expected_session AND "userId"=expected_user FOR SHARE;
  IF NOT FOUND OR session_expiry <= (clock_timestamp() AT TIME ZONE 'UTC') THEN RETURN 'unauthenticated'; END IF;
  -- This also serializes independent users' writes/counts and publication's
  -- FOR UPDATE. A committed withdrawal therefore rejects both PUT and DELETE.
  SELECT state INTO story_state FROM public.story WHERE id=target_story FOR UPDATE;
  IF NOT FOUND OR story_state <> 'PUBLISHED'::public."StoryState" THEN RETURN 'not_found'; END IF;
  IF session_expiry <= (clock_timestamp() AT TIME ZONE 'UTC') THEN RETURN 'unauthenticated'; END IF;
  RETURN 'allowed';
END;
$$;
REVOKE ALL ON FUNCTION public.mq_lock_story_like_access(text,text,uuid) FROM PUBLIC;

COMMIT;
