import assert from "node:assert/strict";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { cpus, totalmem } from "node:os";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { hashPassword as defaultHash, verifyPassword as defaultVerify } from "better-auth/crypto";
import { hashPassword, verifyPassword, PASSWORD_HASH_POLICY } from "../../src/server/auth/password.ts";

// Synthetic, database-free benchmark. Output contains timing/resource metadata only.
// Run on Windows and in Linux CI; it is not a production load or side-channel proof.
const sample = "Synthetic-only-Benchmark-9087!";
const duration = async (operation) => {
  const start = performance.now();
  const result = await operation();
  return { result, ms: Number((performance.now() - start).toFixed(2)) };
};
const mean = (values) => Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));

async function measure(hash, verify) {
  const warmup = await hash(sample);
  assert.equal(await verify({ hash: warmup, password: sample }), true);
  const hashMs = [];
  const verifyMs = [];
  const rssStart = process.memoryUsage().rss;
  let rssPeak = rssStart;
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  for (let index = 0; index < 5; index += 1) {
    const hashed = await duration(() => hash(sample));
    const verified = await duration(() => verify({ hash: hashed.result, password: sample }));
    assert.equal(verified.result, true);
    hashMs.push(hashed.ms);
    verifyMs.push(verified.ms);
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }
  const concurrent = await duration(() => Promise.all(Array.from({ length: 6 }, () => hash(sample))));
  const concurrentVerified = await duration(() => Promise.all(concurrent.result.map((value) => verify({ hash: value, password: sample }))));
  assert.equal(concurrentVerified.result.every(Boolean), true);
  rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  loop.disable();
  return {
    hashMs, verifyMs, meanHashMs: mean(hashMs), meanVerifyMs: mean(verifyMs),
    sixJobsHashWallMs: concurrent.ms, sixJobsVerifyWallMs: concurrentVerified.ms,
    eventLoopDelayMeanMs: Number((loop.mean / 1e6).toFixed(2)),
    eventLoopDelayMaxMs: Number((loop.max / 1e6).toFixed(2)),
    observedRssAfterJobsMiB: Number((rssPeak / 1024 / 1024).toFixed(2)),
  };
}

const betterAuthDefault = await measure(defaultHash, defaultVerify);
const projectScrypt = await measure(hashPassword, verifyPassword);
const betterAuthPackage = JSON.parse(await readFile(new URL("../../node_modules/better-auth/package.json", import.meta.url), "utf8"));
console.log(JSON.stringify({
  timestamp: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, architecture: process.arch, logicalCpuCount: cpus().length, hostMemoryGiB: Number((totalmem() / 1024 ** 3).toFixed(2)) },
  betterAuthDefault: { version: betterAuthPackage.version, N: 16384, r: 16, p: 1, measurements: betterAuthDefault },
  projectScrypt: { policy: PASSWORD_HASH_POLICY, measurements: projectScrypt },
  qualification: "Synthetic sample, five sequential plus six concurrent jobs. RSS sampled after jobs is not native allocation peak. Default concurrency is not bounded; project concurrency is capped at two. Resource limits apply per Node process, not across replicas. No passwords, salts or hashes emitted.",
}, null, 2));
