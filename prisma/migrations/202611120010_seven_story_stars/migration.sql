-- Add four stable story entrances; existing slots and story bindings stay intact.
BEGIN;

INSERT INTO "star_slot" ("id", "scene_key") VALUES
    ('star-4', 'story-position--4'),
    ('star-5', 'story-position--5'),
    ('star-6', 'story-position--6'),
    ('star-7', 'story-position--7');

COMMIT;
