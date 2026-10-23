-- Infrastructure-only synthetic probe; no users, stories, or private data.
CREATE TABLE "database_probe" (
    "id" UUID NOT NULL,
    "value" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "database_probe_pkey" PRIMARY KEY ("id")
);
