import sharp from "sharp";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { setTimeout } from "node:timers";

sharp.cache(false);
sharp.concurrency(1);
const MAX_PIXELS = 24_000_000;
const inputOptions = { limitInputPixels: MAX_PIXELS, limitInputChannels: 4, failOn: "warning" };
const rejected = code => Object.assign(new Error(code), { code });

function formatOf(input) {
  if (input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return "jpeg";
  if (input.length >= 8 && input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    for (let offset = 8; offset + 12 <= input.length;) {
      const length = input.readUInt32BE(offset);
      if (length > input.length - offset - 12) throw rejected("INVALID_IMAGE");
      if (input.toString("ascii", offset + 4, offset + 8) === "acTL") throw rejected("ANIMATED_IMAGE");
      offset += length + 12;
    }
    return "png";
  }
  if (input.length >= 12 && input.toString("ascii", 0, 4) === "RIFF" && input.toString("ascii", 8, 12) === "WEBP") {
    const end = input.readUInt32LE(4) + 8;
    if (end !== input.length) throw rejected("INVALID_IMAGE");
    for (let offset = 12; offset + 8 <= end;) {
      const type = input.toString("ascii", offset, offset + 4), length = input.readUInt32LE(offset + 4);
      if (length > end - offset - 8) throw rejected("INVALID_IMAGE");
      if (type === "ANIM" || type === "ANMF" || (type === "VP8X" && length > 0 && (input[offset + 8] & 2))) {
        throw rejected("ANIMATED_IMAGE");
      }
      offset += 8 + length + (length % 2);
    }
    return "webp";
  }
  throw rejected("UNSUPPORTED_IMAGE");
}

const variant = ({ data, info }) => ({
  bytes: data, mimeType: "image/webp", width: info.width, height: info.height,
  byteLength: data.length, sha256: createHash("sha256").update(data).digest("hex"),
});

/** Internal worker operation. Lower output caps support real decoder tests;
 * no caller-controlled path, URL, format, metadata or processing options. */
export async function decodeMedia(input, limits = { display: 4 * 1024 * 1024, thumbnail: 256 * 1024 }) {
  try {
    const format = formatOf(input);
    const metadata = await sharp(input, inputOptions).metadata();
    if (metadata.format !== format) throw rejected("INVALID_IMAGE");
    if ((metadata.pages ?? 1) !== 1 || metadata.loop !== undefined || metadata.delay !== undefined) throw rejected("ANIMATED_IMAGE");
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS) throw rejected("PIXEL_LIMIT");
    // Re-encoding strips EXIF/GPS/XMP/ICC by default. Orientation is applied to
    // pixels first; no keepMetadata/withMetadata method is used.
    const display = await sharp(input, inputOptions).autoOrient()
      .resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82, effort: 3 }).timeout({ seconds: 10 }).toBuffer({ resolveWithObject: true });
    if (display.data.length > limits.display) throw rejected("OUTPUT_TOO_LARGE");
    const thumbnail = await sharp(display.data, inputOptions)
      .resize({ width: 400, height: 400, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 76, effort: 3 }).timeout({ seconds: 10 }).toBuffer({ resolveWithObject: true });
    if (thumbnail.data.length > limits.thumbnail) throw rejected("OUTPUT_TOO_LARGE");
    return { inputMimeType: `image/${format}`, display: variant(display), thumbnail: variant(thumbnail) };
  } catch (error) {
    if (["UNSUPPORTED_IMAGE", "ANIMATED_IMAGE", "INVALID_IMAGE", "PIXEL_LIMIT", "OUTPUT_TOO_LARGE"].includes(error.code)) throw error;
    throw rejected(error.message?.includes("pixel limit") ? "PIXEL_LIMIT" : "INVALID_IMAGE");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Also stop when the HTTP process disappears; no detached decoder is kept.
  process.once("disconnect", () => process.exit(1));
  setTimeout(() => process.exit(1), 12_000).unref();
  process.once("message", async message => {
    let response;
    try { response = { ok: true, result: await decodeMedia(message.input) }; }
    catch (error) { response = { ok: false, code: error.code ?? "INVALID_IMAGE" }; }
    // This child does not write original input to disk, stdout, stderr or logs.
    process.send(response, () => process.exit(0));
  });
}
