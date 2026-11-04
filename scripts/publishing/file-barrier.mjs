// Loaded ONLY by this suite's test-owned Node process, before Next starts.
// Real file bytes and PostgreSQL remain in use; this schedules the filesystem
// interval so concurrent HTTP edits/revocation can be tested deterministically.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const marker = process.env.MQ_PUBLISH_TEST_GATE_FILE;
if (marker) {
  const originalOpen = fs.promises.open.bind(fs.promises);
  const originalRead = fs.promises.readFile.bind(fs.promises);
  const originalWrite = fs.promises.writeFile.bind(fs.promises);
  const seen = new Set();
  fs.promises.open = async function open(file, ...options) {
    if (typeof file === "string" && file.endsWith("display.webp")) {
      let config;
      try { config = JSON.parse(await originalRead(marker, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (config?.target === file && !seen.has(config.nonce)) {
        seen.add(config.nonce); await originalWrite(config.entered, config.nonce, { mode: 0o600 });
        let released = false;
        for (let attempt = 0; attempt < 1000; attempt++) {
          try { released = (await originalRead(config.release, "utf8")) === config.nonce; }
          catch (error) { if (error.code !== "ENOENT") throw error; }
          if (released) break;
          await delay(10);
        }
        if (!released) throw new Error("PUBLISH_TEST_FILE_BARRIER_TIMEOUT");
      }
    }
    return originalOpen(file, ...options);
  };
  syncBuiltinESMExports();
}
