import { fork } from "node:child_process";
import { resolve } from "node:path";

export const MEDIA_INPUT_LIMIT = 3 * 1024 * 1024;
export const MEDIA_DISPLAY_LIMIT = 4 * 1024 * 1024;
export const MEDIA_THUMBNAIL_LIMIT = 256 * 1024;
export type InputImageMime = "image/jpeg" | "image/png" | "image/webp";
export type ProcessedVariant = Readonly<{
  bytes: Buffer; mimeType: "image/webp"; width: number; height: number; byteLength: number; sha256: string;
}>;
export type ProcessedMedia = Readonly<{
  inputMimeType: InputImageMime; display: ProcessedVariant; thumbnail: ProcessedVariant;
}>;

const statuses = {
  INPUT_TOO_LARGE: 413, PIXEL_LIMIT: 413, OUTPUT_TOO_LARGE: 413,
  UNSUPPORTED_IMAGE: 415, ANIMATED_IMAGE: 415, INVALID_IMAGE: 422,
  PROCESSOR_BUSY: 503, PROCESSING_TIMEOUT: 503, PROCESSOR_FAILED: 503, PROCESSING_ABORTED: 499,
} as const;
export type MediaProcessingCode = keyof typeof statuses;
export class MediaProcessingError extends Error {
  readonly code: MediaProcessingCode;
  readonly status: number;
  constructor(code: MediaProcessingCode) {
    super(code); this.name = "MediaProcessingError"; this.code = code; this.status = statuses[code];
  }
}

type Job = {
  input: Buffer; signal?: AbortSignal; resolve: (value: ProcessedMedia) => void; reject: (error: Error) => void;
  cancel: () => void; abort: () => void; waitingTimer?: ReturnType<typeof setTimeout>;
};

/** One killable child per job; no unbounded native tasks remain after a timeout.
 * The optional lower limits/worker path are code-level integration-test seams,
 * never selected from an HTTP request or environment variable. Deployment must
 * include scripts/media/image-worker.mjs and the pinned Sharp native package.
 */
export function createMediaProcessor(options: {
  workerPath?: string; timeoutMs?: number; activeLimit?: number; waitingLimit?: number;
} = {}) {
  const workerPath = options.workerPath ?? resolve(process.cwd(), "scripts/media/image-worker.mjs");
  const timeoutMs = options.timeoutMs ?? 12_000;
  const activeLimit = options.activeLimit ?? 2;
  const waitingLimit = options.waitingLimit ?? 2;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 12_000
    || !Number.isInteger(activeLimit) || activeLimit < 1 || activeLimit > 2
    || !Number.isInteger(waitingLimit) || waitingLimit < 0 || waitingLimit > 2) {
    throw new Error("INVALID_PROCESSOR_CONFIGURATION");
  }
  let active = 0;
  const waiting: Job[] = [];
  const cleanup = (job: Job) => {
    clearTimeout(job.waitingTimer); job.signal?.removeEventListener("abort", job.abort);
  };
  function start(job: Job) {
    clearTimeout(job.waitingTimer);
    if (job.signal?.aborted) { cleanup(job); job.reject(new MediaProcessingError("PROCESSING_ABORTED")); return; }
    active += 1;
    // Do not inherit database URLs, authentication secrets, NODE_OPTIONS or
    // tracing hooks. The native child receives only image bytes via IPC.
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production", UV_THREADPOOL_SIZE: "1", MALLOC_ARENA_MAX: "2" };
    for (const key of ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    // Worker is shipped explicitly via outputFileTracingIncludes, not bundled.
    const child = fork(/* turbopackIgnore: true */ workerPath, [], {
      env, windowsHide: true, serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: ["--max-old-space-size=96"],
    });
    let result: ProcessedMedia | undefined;
    let failure: MediaProcessingError | undefined;
    const stop = (code: MediaProcessingCode) => {
      failure ??= new MediaProcessingError(code);
      child.kill("SIGKILL");
    };
    job.cancel = () => stop("PROCESSING_ABORTED");
    const timer = setTimeout(() => stop("PROCESSING_TIMEOUT"), timeoutMs);
    child.once("error", () => { failure ??= new MediaProcessingError("PROCESSOR_FAILED"); });
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || !("ok" in message)) return stop("PROCESSOR_FAILED");
      if (message.ok !== true) {
        const code = "code" in message ? message.code : undefined;
        failure = new MediaProcessingError(typeof code === "string" && Object.hasOwn(statuses, code)
          ? code as MediaProcessingCode : "PROCESSOR_FAILED");
        return;
      }
      // The child protocol is the boundary around a native decoder. Keep output
      // memory bounded even if a worker exits with an incomplete/invalid result.
      const value = (message as { result?: ProcessedMedia }).result;
      if (!value || !["image/jpeg", "image/png", "image/webp"].includes(value.inputMimeType)) return stop("PROCESSOR_FAILED");
      for (const [variant, limit, edge] of [[value.display, MEDIA_DISPLAY_LIMIT, 1920], [value.thumbnail, MEDIA_THUMBNAIL_LIMIT, 400]] as const) {
        if (!variant || !Buffer.isBuffer(variant.bytes) || variant.bytes.length === 0 || variant.bytes.length > limit
          || variant.byteLength !== variant.bytes.length || variant.mimeType !== "image/webp"
          || !Number.isInteger(variant.width) || !Number.isInteger(variant.height)
          || variant.width < 1 || variant.height < 1 || Math.max(variant.width, variant.height) > edge
          || !/^[0-9a-f]{64}$/.test(variant.sha256)) return stop("PROCESSOR_FAILED");
      }
      result = value;
    });
    child.once("close", code => {
      clearTimeout(timer); cleanup(job); active -= 1;
      // Only close releases capacity, not Promise timeout or receipt of IPC.
      if (failure) job.reject(failure);
      else if (code !== 0 || !result) job.reject(new MediaProcessingError("PROCESSOR_FAILED"));
      else job.resolve(result);
      while (active < activeLimit && waiting.length) start(waiting.shift()!);
    });
    child.send({ input: job.input }, error => { if (error) stop("PROCESSOR_FAILED"); });
  }

  return (input: Buffer, { signal }: { signal?: AbortSignal } = {}): Promise<ProcessedMedia> => {
    if (!Buffer.isBuffer(input) || input.length === 0) return Promise.reject(new MediaProcessingError("INVALID_IMAGE"));
    if (input.length > MEDIA_INPUT_LIMIT) return Promise.reject(new MediaProcessingError("INPUT_TOO_LARGE"));
    if (signal?.aborted) return Promise.reject(new MediaProcessingError("PROCESSING_ABORTED"));
    if (active >= activeLimit && waiting.length >= waitingLimit) return Promise.reject(new MediaProcessingError("PROCESSOR_BUSY"));
    return new Promise((resolveJob, reject) => {
      const job: Job = { input, signal, resolve: resolveJob, reject, cancel: () => {}, abort: () => job.cancel() };
      signal?.addEventListener("abort", job.abort, { once: true });
      if (active < activeLimit) { start(job); return; }
      job.cancel = () => {
        const index = waiting.indexOf(job);
        if (index !== -1) waiting.splice(index, 1);
        cleanup(job); reject(new MediaProcessingError("PROCESSING_ABORTED"));
      };
      job.waitingTimer = setTimeout(() => {
        const index = waiting.indexOf(job);
        if (index !== -1) waiting.splice(index, 1);
        cleanup(job); reject(new MediaProcessingError("PROCESSING_TIMEOUT"));
      }, timeoutMs);
      waiting.push(job);
    });
  };
}

export const processMediaImage = createMediaProcessor();
