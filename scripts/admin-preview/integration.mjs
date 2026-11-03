import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

try {
  process.env.MQ_DRAFT_BROWSER_MODULE = fileURLToPath(new URL("./browser-tests.mjs", import.meta.url));
  process.env.DRAFT_BROWSER_EVIDENCE_DIR ||= await mkdtemp(join(tmpdir(), "mq-preview-evidence-"));
  await import("../admin-drafts/integration.mjs");
} catch {
  console.error("Preview integration setup failed; sensitive details withheld");
  process.exitCode = 1;
}
