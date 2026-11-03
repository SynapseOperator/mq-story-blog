import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { createMediaProcessor, processMediaImage, MediaProcessingError, MEDIA_INPUT_LIMIT } from "../src/server/media/processor.ts";
import { decodeMedia } from "../scripts/media/image-worker.mjs";
const { AbortController } = globalThis;

const rejects = expected => error => error instanceof MediaProcessingError && error.code === expected
  && error.message === expected && !Object.hasOwn(error, "cause");
const input = (width = 96, height = 64) => sharp({ create: { width, height, channels: 3, background: { r: 70, g: 110, b: 160 } } });

async function checkVariant(value, expectedWidth, expectedHeight) {
  const metadata = await sharp(value.bytes).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(value.mimeType, "image/webp");
  assert.equal(value.width, expectedWidth); assert.equal(value.height, expectedHeight);
  assert.equal(metadata.width, value.width); assert.equal(metadata.height, value.height);
  assert.equal(value.byteLength, value.bytes.length);
  assert.equal(value.sha256, createHash("sha256").update(value.bytes).digest("hex"));
  for (const field of ["exif", "xmp", "icc", "iptc", "orientation"]) assert.equal(metadata[field], undefined);
}

test("processor really decodes JPEG, PNG and static WebP into bounded private WebP variants", async () => {
  assert.equal(sharp.versions.sharp, "0.35.5");
  for (const format of ["jpeg", "png", "webp"]) {
    const result = await processMediaImage(await input(2400, 1200).toFormat(format).toBuffer());
    assert.equal(result.inputMimeType, `image/${format}`);
    await checkVariant(result.display, 1920, 960);
    await checkVariant(result.thumbnail, 400, 200);
  }
  const small = await processMediaImage(await input().png().toBuffer());
  await checkVariant(small.display, 96, 64);
  await checkVariant(small.thumbnail, 96, 64);
});

test("EXIF direction becomes pixels and EXIF/GPS/XMP are removed from both real outputs", async () => {
  const original = await input(120, 80).jpeg().withMetadata({ orientation: 6 })
    .withExifMerge({ IFD0: { Artist: "SYNTHETIC_ONLY" }, IFD3: {
      GPSLatitudeRef: "N", GPSLatitude: "1/1 2/1 3/1", GPSLongitudeRef: "E", GPSLongitude: "4/1 5/1 6/1",
    } }).withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">SYNTHETIC_PRIVATE_METADATA</x:xmpmeta>').toBuffer();
  const source = await sharp(original).metadata();
  assert.equal(source.orientation, 6); assert.ok(source.exif); assert.ok(source.xmp);
  assert.ok(source.exif.includes(Buffer.from("SYNTHETIC_ONLY")));
  const tiff = source.exif.subarray(6);
  assert.equal(tiff.toString("ascii", 0, 2), "II");
  const firstIfd = tiff.readUInt32LE(4), entries = tiff.readUInt16LE(firstIfd);
  assert.ok(Array.from({ length: entries }, (_, index) => tiff.readUInt16LE(firstIfd + 2 + index * 12)).includes(0x8825),
    "synthetic source really includes the GPS IFD tag");
  const result = await processMediaImage(original);
  await checkVariant(result.display, 80, 120);
  await checkVariant(result.thumbnail, 80, 120);
  assert.equal(result.display.bytes.includes(Buffer.from("SYNTHETIC_PRIVATE_METADATA")), false);
});

test("content signatures reject SVG, GIF, HEIC-like data, URL strings and corrupt images without raw decoder errors", async () => {
  const gif = await input().gif().toBuffer();
  const fixtures = [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), gif,
    Buffer.from("\0\0\0\x18ftypheicSYNTHETIC"), Buffer.from("https://example.invalid/private.png")];
  for (const bytes of fixtures) await assert.rejects(processMediaImage(bytes), rejects("UNSUPPORTED_IMAGE"));
  await assert.rejects(processMediaImage(Buffer.from([0xff, 0xd8, 0xff, 0x00])), rejects("INVALID_IMAGE"));
  const jpeg = await input(2400, 1200).jpeg().toBuffer();
  await assert.rejects(processMediaImage(jpeg.subarray(0, Math.floor(jpeg.length / 2))), rejects("INVALID_IMAGE"));
  await assert.rejects(processMediaImage(Buffer.alloc(0)), rejects("INVALID_IMAGE"));
  await assert.rejects(processMediaImage(Buffer.alloc(MEDIA_INPUT_LIMIT + 1)), rejects("INPUT_TOO_LARGE"));
});

test("24 million decoded pixels and output byte caps are real decoder limits", async () => {
  const overPixels = await input(6001, 4000).png().toBuffer();
  assert.ok(overPixels.length < MEDIA_INPUT_LIMIT);
  await assert.rejects(processMediaImage(overPixels), rejects("PIXEL_LIMIT"));
  const bytes = await input().png().toBuffer();
  await assert.rejects(decodeMedia(bytes, { display: 1, thumbnail: 262144 }), error => error.code === "OUTPUT_TOO_LARGE");
  await assert.rejects(decodeMedia(bytes, { display: 4194304, thumbnail: 1 }), error => error.code === "OUTPUT_TOO_LARGE");
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, value) {
  const size = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), value]);
  size.writeUInt32BE(value.length); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, crc]);
}
async function animatedPng() {
  const base = await input(16, 16).png().toBuffer();
  const chunks = [];
  for (let offset = 8; offset < base.length;) {
    const size = base.readUInt32BE(offset), type = base.toString("ascii", offset + 4, offset + 8);
    chunks.push({ type, bytes: base.subarray(offset, offset + size + 12), data: base.subarray(offset + 8, offset + 8 + size) });
    offset += size + 12;
  }
  const animation = Buffer.alloc(8); animation.writeUInt32BE(2);
  const frame = sequence => {
    const value = Buffer.alloc(26); value.writeUInt32BE(sequence); value.writeUInt32BE(16, 4); value.writeUInt32BE(16, 8);
    value.writeUInt16BE(1, 20); value.writeUInt16BE(10, 22); return chunk("fcTL", value);
  };
  const data = Buffer.concat(chunks.filter(item => item.type === "IDAT").map(item => item.data));
  const secondData = Buffer.alloc(4); secondData.writeUInt32BE(2);
  return Buffer.concat([base.subarray(0, 8), chunks.find(item => item.type === "IHDR").bytes,
    chunk("acTL", animation), frame(0), chunk("IDAT", data), frame(1), chunk("fdAT", Buffer.concat([secondData, data])), chunk("IEND", Buffer.alloc(0))]);
}

test("real animated WebP and APNG control frames are rejected instead of silently extracting frame one", async () => {
  const frames = await Promise.all(["red", "blue"].map(background => sharp({ create: { width: 16, height: 16, channels: 3, background } }).png().toBuffer()));
  const webp = await sharp(frames, { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(webp, { animated: true }).metadata()).pages, 2);
  await assert.rejects(processMediaImage(webp), rejects("ANIMATED_IMAGE"));
  const apng = await animatedPng();
  assert.equal((await sharp(apng).metadata()).format, "png");
  await assert.rejects(processMediaImage(apng), rejects("ANIMATED_IMAGE"));
});

async function childFixture(t, source) {
  const directory = await mkdtemp(join(tmpdir(), "mq-media-worker-test-"));
  const workerPath = join(directory, "worker.mjs"), marker = join(directory, "pid.txt");
  await writeFile(workerPath, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, String(process.pid));\n${source}`, { flag: "wx" });
  t.after(async () => {
    const actual = await realpath(directory), parent = await realpath(tmpdir());
    assert.equal(dirname(actual), parent); assert.equal(actual, resolve(directory));
    await rm(actual, { recursive: true, force: false });
  });
  return { workerPath, marker };
}
async function waitPid(marker) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return Number(await readFile(marker, "utf8")); } catch { await delay(10); }
  }
  throw new Error("Test-owned worker did not start");
}
function isStopped(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { assert.equal(error.code, "ESRCH"); return true; }
}

test("timeout kills a real blocked child before capacity is released", async t => {
  const { workerPath, marker } = await childFixture(t, 'process.on("message", () => { while (true) {} });');
  const processImage = createMediaProcessor({ workerPath, activeLimit: 1, waitingLimit: 0, timeoutMs: 800 });
  const first = processImage(Buffer.from("synthetic input"));
  const failure = assert.rejects(first, rejects("PROCESSING_TIMEOUT"));
  const pid = await waitPid(marker);
  await assert.rejects(processImage(Buffer.from("rejected capacity")), rejects("PROCESSOR_BUSY"));
  await failure;
  assert.equal(isStopped(pid), true);
});

test("waiting queue is bounded and abort removes queued or executing work without detached children", async t => {
  const { workerPath, marker } = await childFixture(t, 'process.on("message", () => { while (true) {} });');
  const processImage = createMediaProcessor({ workerPath, activeLimit: 1, waitingLimit: 1, timeoutMs: 3000 });
  const running = new AbortController(), queued = new AbortController();
  const first = processImage(Buffer.from("running"), { signal: running.signal });
  const firstRejected = assert.rejects(first, rejects("PROCESSING_ABORTED"));
  const pid = await waitPid(marker);
  const second = processImage(Buffer.from("waiting"), { signal: queued.signal });
  const secondRejected = assert.rejects(second, rejects("PROCESSING_ABORTED"));
  await assert.rejects(processImage(Buffer.from("excess")), rejects("PROCESSOR_BUSY"));
  queued.abort(); await secondRejected;
  running.abort(); await firstRejected;
  assert.equal(isStopped(pid), true);
});

test("a real interrupted processing child reports only a fixed failure and the next job still executes", async t => {
  const { workerPath, marker } = await childFixture(t, 'process.on("message", () => process.exit(2));');
  const processImage = createMediaProcessor({ workerPath, activeLimit: 1, waitingLimit: 0 });
  await assert.rejects(processImage(Buffer.from("synthetic")), rejects("PROCESSOR_FAILED"));
  const firstPid = Number(await readFile(marker, "utf8")); assert.equal(isStopped(firstPid), true);
  await assert.rejects(processImage(Buffer.from("another synthetic")), rejects("PROCESSOR_FAILED"));
  assert.notEqual(Number(await readFile(marker, "utf8")), firstPid);
});

test("decoder child does not inherit database secrets or Node hooks", async t => {
  const { workerPath } = await childFixture(t, `process.on('message', () => {
    const safe = !process.env.DATABASE_URL && !process.env.MQ_AUTH_SECRET && !process.env.NODE_OPTIONS;
    process.send({ok:false,code:safe?'INVALID_IMAGE':'PROCESSOR_FAILED'}, () => process.exit(0));
  });`);
  const previous = { DATABASE_URL: process.env.DATABASE_URL, MQ_AUTH_SECRET: process.env.MQ_AUTH_SECRET };
  process.env.DATABASE_URL = "SYNTHETIC_PRIVATE_CONNECTION"; process.env.MQ_AUTH_SECRET = "SYNTHETIC_PRIVATE_SECRET";
  try { await assert.rejects(createMediaProcessor({ workerPath })(Buffer.from("synthetic")), rejects("INVALID_IMAGE")); }
  finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
