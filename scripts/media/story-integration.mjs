import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

// Extend the existing upload runner with a third, independently migrated test
// database. The parent owns cleanup, restricted roles, private roots and TLS.
try {
  process.env.MQ_MEDIA_STORY_TESTS = "true";
  process.env.MQ_MEDIA_STORY_BROWSER_MODULE = fileURLToPath(new URL("./story-browser-tests.mjs", import.meta.url));
  process.env.MEDIA_STORY_EVIDENCE_DIR ||= await mkdtemp(join(tmpdir(), "mq-story-media-evidence-"));
  await import("./upload-integration.mjs");
} catch {
  console.error("Story media integration setup failed; sensitive details withheld"); process.exitCode = 1;
}
