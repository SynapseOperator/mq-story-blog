import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

// Use the existing isolated PostgreSQL/least-privilege/TLS lifecycle rather
// than constructing a second environment. Only synthetic UI evidence is kept;
// the parent runner cleans its own processes, roles and temporary databases.
try {
  process.env.MQ_DRAFT_BROWSER_MODULE = fileURLToPath(new URL("./browser-tests.mjs", import.meta.url));
  process.env.DRAFT_BROWSER_EVIDENCE_DIR ||= await mkdtemp(join(tmpdir(), "mq-editor-evidence-"));
  await import("../admin-drafts/integration.mjs");
} catch {
  console.error("Editor integration setup failed; sensitive details withheld");
  process.exitCode = 1;
}
