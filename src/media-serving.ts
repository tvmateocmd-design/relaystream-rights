import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export class MediaError extends Error {
  constructor(readonly statusCode: number, readonly code: string) { super(code); }
}
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
function normalized(value: string) { return process.platform === "win32" ? value.toLowerCase() : value; }
function samePath(a: string, b: string) { return normalized(path.resolve(a)) === normalized(path.resolve(b)); }

/** Reject links, including junctions, at every permitted path component. */
async function permittedFile(root: string, filePath: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(filePath);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new MediaError(404, "MEDIA_NOT_APPROVED");
  }
  const rootStat = await lstat(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !samePath(await realpath(resolvedRoot), resolvedRoot)) {
    throw new MediaError(404, "MEDIA_NOT_APPROVED");
  }
  let current = resolvedRoot;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new MediaError(404, "MEDIA_NOT_APPROVED");
  }
  if (!samePath(await realpath(resolvedFile), resolvedFile)) throw new MediaError(404, "MEDIA_NOT_APPROVED");
  return resolvedFile;
}

export async function readVerifiedMedia(root: string, filePath: string, expectedHash: string, expectedSize: number): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || !Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > MAX_MEDIA_BYTES) {
    throw new MediaError(422, "INVALID_MEDIA_COMMITMENT");
  }
  try {
    const approved = await permittedFile(root, filePath);
    const file = await open(approved, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== expectedSize) throw new MediaError(422, "MEDIA_INTEGRITY_FAILED");
      // Bounded reads also handle a file growing after stat. Serve this exact verified buffer.
      const bytes = Buffer.alloc(expectedSize + 1);
      let read = 0;
      while (read < bytes.length) {
        const chunk = await file.read(bytes, read, bytes.length - read, read);
        if (!chunk.bytesRead) break;
        read += chunk.bytesRead;
      }
      const media = bytes.subarray(0, read);
      if (read !== expectedSize || createHash("sha256").update(media).digest("hex") !== expectedHash) {
        throw new MediaError(422, "MEDIA_INTEGRITY_FAILED");
      }
      return media;
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError(404, "MEDIA_UNAVAILABLE");
  }
}

export function sourceApproved(filePath: string, fixedFixture: string) { return samePath(filePath, fixedFixture); }
export function outputApproved(filePath: string, outputRoot: string, executionId: string) {
  return /^[0-9a-f-]{36}$/i.test(executionId) && samePath(filePath, path.join(outputRoot, executionId, "output.mp4"));
}

function rangeFor(value: string, size: number): [number, number] {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new MediaError(416, "INVALID_RANGE");
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new MediaError(416, "INVALID_RANGE");
    return [Math.max(0, size - suffix), size - 1];
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) throw new MediaError(416, "INVALID_RANGE");
  return [start, Math.min(end, size - 1)];
}

export function sendMedia(request: IncomingMessage, response: ServerResponse, bytes: Buffer, hash: string) {
  const etag = `"${hash}"`;
  const headers = { "Content-Type": "video/mp4", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
    "Accept-Ranges": "bytes", ETag: etag };
  // RFC range semantics apply to GET; HEAD returns full representation headers only.
  const range = request.method === "GET" && (!request.headers["if-range"] || request.headers["if-range"] === etag) ? request.headers.range : undefined;
  let start = 0, end = bytes.length - 1;
  if (range) {
    try { [start, end] = rangeFor(range, bytes.length); }
    catch {
      response.writeHead(416, { ...headers, "Content-Range": `bytes */${bytes.length}`, "Content-Length": 0 }); response.end(); return;
    }
  }
  response.writeHead(range ? 206 : 200, { ...headers, "Content-Length": end - start + 1,
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${bytes.length}` } : {}) });
  response.end(request.method === "HEAD" ? undefined : bytes.subarray(start, end + 1));
}

// Future interface files only. No files or visual UI are created in this checkpoint.
export const FRONTEND_FILES: Readonly<Record<string, string>> = Object.freeze({
  "/": "index.html", "/index.html": "index.html", "/styles.css": "styles.css", "/app.mjs": "app.mjs", "/view-model.mjs": "view-model.mjs",
});
export async function readFrontendFile(root: string, route: string) {
  const name = Object.hasOwn(FRONTEND_FILES, route) ? FRONTEND_FILES[route] : undefined;
  if (!name) throw new MediaError(404, "STATIC_NOT_APPROVED");
  try {
    const filePath = await permittedFile(root, path.join(root, name));
    const file = await open(filePath, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 256 * 1024) throw new MediaError(404, "STATIC_NOT_APPROVED");
      const bytes = await file.readFile();
      if (bytes.length > 256 * 1024) throw new MediaError(404, "STATIC_NOT_APPROVED");
      return { bytes, contentType: name.endsWith(".html") ? "text/html; charset=utf-8" : name.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" };
    } finally { await file.close(); }
  } catch (error) { if (error instanceof MediaError) throw error; throw new MediaError(404, "STATIC_UNAVAILABLE"); }
}
