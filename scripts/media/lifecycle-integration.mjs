// Keep the established isolated roles, PostgreSQL, private roots and verified
// TLS harness. Lifecycle tests use an additional independently migrated DB.
process.env.MQ_MEDIA_LIFECYCLE_TESTS = "true";
await import("./upload-integration.mjs");
