/** Only local demo callers use HTTP; the actual app still enforces its Origin. */
export function demoRequest(address, origin = address) {
  return async (path, { method = "GET", body, bytes, jar, requestOrigin = origin, headers = {} } = {}) => {
    const response = await globalThis.fetch(new URL(path, address), { method, signal: AbortSignal.timeout(30000),
      headers: { origin: requestOrigin, ...(jar?.cookie ? { cookie: jar.cookie } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? bytes : JSON.stringify(body) });
    for (const line of response.headers.getSetCookie()) if (jar && /^mq\.session_token=/.test(line)) {
      jar.cookie = /max-age=0(?:;|$)/i.test(line) ? "" : line.split(";", 1)[0];
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes: buffer,
      data: /application\/json/.test(response.headers.get("content-type") ?? "") ? JSON.parse(buffer.toString("utf8")) : null };
  };
}
import { URL } from "node:url";
