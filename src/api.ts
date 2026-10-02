import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { executeAuthorizedTransformation, verifyPermission, type ExecutionDependencies, type ExecutionOptions } from "./index";
import { registerMedia, type RegisteredMediaAsset, type RightsAction, type RightsPolicy } from "./register-media";
import { bootstrapDemo, demoConfiguration } from "./demo-config";
import { DemoExecutions, DemoRequestError, PUBLIC_ID, REQUEST_ID } from "./demo-executions";
import { FRONTEND_FILES, MediaError, outputApproved, readFrontendFile, readVerifiedMedia, sendMedia, sourceApproved } from "./media-serving";
import type { RoyaltyRule } from "./royalties";

const PORT = 3000;
export interface ApiOptions {
  demo?: boolean;
  workspaceRoot?: string;
  assets?: Map<string, RegisteredMediaAsset>;
  dependencies?: ExecutionDependencies;
  executionOptions?: ExecutionOptions;
  registryCapacity?: number;
}
function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body, null, 2));
}
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 16 * 1024) throw new DemoRequestError(413, "REQUEST_TOO_LARGE");
    chunks.push(bytes);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8").trim() || "{}"); }
  catch { throw new DemoRequestError(400, "INVALID_JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new DemoRequestError(400, "INVALID_JSON_OBJECT");
  return parsed as Record<string, unknown>;
}
function isRightsAction(value: unknown): value is RightsAction {
  return value === "commercialUse" || value === "aiTraining" || value === "derivatives" || value === "transcoding";
}
function id(value: unknown, strict: boolean): value is string {
  return typeof value === "string" && value.length > 0 && (!strict || PUBLIC_ID.test(value));
}

function safePathname(rawUrl: string, host: string) {
  const rawPath = rawUrl.split("?")[0]!;
  if (!rawPath.startsWith("/") || rawPath.startsWith("//")) throw new DemoRequestError(400, "INVALID_ROUTE");
  let decoded = rawPath;
  for (let i = 0; i < 3; i++) {
    if (/%(?:2f|5c)/i.test(decoded)) throw new DemoRequestError(400, "INVALID_ROUTE");
    try { decoded = decodeURIComponent(decoded); } catch { throw new DemoRequestError(400, "INVALID_ROUTE"); }
    if (decoded.includes("\\") || decoded.includes("\0") || decoded.split("/").some(p => p === "." || p === "..")) {
      throw new DemoRequestError(400, "INVALID_ROUTE");
    }
  }
  return new URL(rawUrl, `http://${host}`);
}

export function createApiServer(options: ApiOptions = {}) {
  const assets = options.assets ?? new Map<string, RegisteredMediaAsset>();
  const config = demoConfiguration(options.workspaceRoot);
  if (options.demo) bootstrapDemo(assets, options.workspaceRoot);
  const executions = new DemoExecutions(config.outputRoot, options.dependencies, options.registryCapacity, options.executionOptions);
  const server = http.createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const host = request.headers.host ?? "";
      if (options.demo) {
        if (!/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(host)
          || Number(new URL(`http://${host}`).port || 80) !== request.socket.localPort) {
          throw new DemoRequestError(403, "INVALID_HOST");
        }
        if (method !== "GET" && method !== "HEAD" && request.headers.origin && request.headers.origin !== `http://${host}`) {
          throw new DemoRequestError(403, "CROSS_ORIGIN_WRITE_REJECTED");
        }
      }
      const url = safePathname(request.url ?? "/", host || "localhost");
      if (options.demo && [...url.searchParams.keys()].some(key => key !== "async" || url.pathname !== "/actions/execute")) {
        throw new DemoRequestError(400, "INVALID_QUERY");
      }
      if (method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { service: "RelayStream Rights API", status: "online", network: "solana-devnet", registeredAssets: assets.size,
          royaltyEngine: "deterministic-allocation", paymentsEnabled: false }); return;
      }
      if (method === "POST" && url.pathname === "/media/register") {
        if (options.demo) throw new DemoRequestError(403, "DEMO_REGISTRATION_DISABLED");
        const body = await readJsonBody(request);
        if (!id(body.assetId, !!options.demo) || typeof body.title !== "string" || !body.title || typeof body.owner !== "string" || !body.owner
          || typeof body.sourceUri !== "string" || !body.sourceUri || typeof body.sourceFilePath !== "string" || !body.sourceFilePath
          || !body.policy || typeof body.policy !== "object") throw new DemoRequestError(400, "MISSING_REGISTRATION_FIELDS");
        const asset = registerMedia({ assetId: body.assetId, title: body.title, owner: body.owner, sourceUri: body.sourceUri,
          sourceFilePath: path.resolve(body.sourceFilePath), policy: body.policy as RightsPolicy,
          ...(body.royaltyRule === undefined ? {} : { royaltyRule: body.royaltyRule as RoyaltyRule }) });
        assets.set(asset.assetId, asset);
        sendJson(response, 201, { status: "registered", asset: { assetId: asset.assetId, title: asset.title, owner: asset.owner, sourceUri: asset.sourceUri,
          sourceSizeBytes: asset.sourceSizeBytes, hashAlgorithm: asset.hashAlgorithm, sourceContentHash: asset.sourceContentHash,
          policyId: asset.policy.policyId, policyHash: asset.policyHash } }); return;
      }
      if (method === "POST" && url.pathname === "/rights/verify") {
        const body = await readJsonBody(request);
        if (!id(body.assetId, !!options.demo) || !isRightsAction(body.action)) throw new DemoRequestError(400, "INVALID_RIGHTS_REQUEST");
        const asset = assets.get(body.assetId);
        if (!asset) throw new DemoRequestError(404, "ASSET_NOT_REGISTERED");
        const result = verifyPermission(asset, body.action);
        sendJson(response, 200, { status: result.authorized ? "authorized" : "blocked", assetId: result.assetId, policyId: result.policyId,
          policyHash: asset.policyHash, policyIntegrityValid: result.policyIntegrityValid, registeredPolicyHash: result.registeredPolicyHash,
          currentPolicyHash: result.currentPolicyHash, action: result.action, decision: result.decision, authorized: result.authorized,
          attributionRequired: result.attributionRequired, provenanceRequired: result.provenanceRequired, reason: result.reason }); return;
      }
      if (method === "POST" && url.pathname === "/actions/execute") {
        const body = await readJsonBody(request);
        if (options.demo && Object.keys(body).some(key => !["requestId", "assetId", "derivedAssetId", "action", "usageAmount"].includes(key))) {
          throw new DemoRequestError(400, "INVALID_EXECUTION_FIELDS");
        }
        if (!id(body.assetId, !!options.demo) || !id(body.derivedAssetId, !!options.demo) || !isRightsAction(body.action)
          || (body.usageAmount !== undefined && typeof body.usageAmount !== "string" && typeof body.usageAmount !== "number")) {
          throw new DemoRequestError(400, "INVALID_EXECUTION_REQUEST");
        }
        const asset = assets.get(body.assetId);
        if (!asset) throw new DemoRequestError(404, "ASSET_NOT_REGISTERED");
        if (url.searchParams.get("async") === "1" || options.demo) {
          const asynchronous = url.searchParams.get("async") === "1";
          if (!options.demo) throw new DemoRequestError(400, "DEMO_MODE_REQUIRED");
          const requestId = body.requestId ?? (asynchronous ? undefined : randomUUID());
          if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) throw new DemoRequestError(400, "INVALID_REQUEST_ID");
          const run = executions.start({ requestId, assetId: body.assetId, derivedAssetId: body.derivedAssetId, action: body.action,
            ...(body.usageAmount === undefined ? {} : { usageAmount: body.usageAmount }) }, asset);
          if (!asynchronous) {
            const finished = await executions.wait(requestId);
            const result = finished.result;
            sendJson(response, result?.status === "blocked" ? 403 : result?.status === "failed" ? 422 : result ? 200 : 503,
              result ?? { error: "EXECUTION_STATE_UNKNOWN", requestId }); return;
          }
          sendJson(response, 202, { requestId: run.requestId, state: run.state, statusUrl: `/executions/${run.requestId}` }); return;
        }
        // Canonical shared DENY and unsupported-action results; no separate HTTP authorization shortcut.
        const execution = await executeAuthorizedTransformation(asset, body.action, body.derivedAssetId,
          { ...options.executionOptions, ...(body.usageAmount === undefined ? {} : { usageAmount: body.usageAmount }) }, options.dependencies);
        sendJson(response, execution.status === "blocked" ? 403 : execution.status === "failed" ? 422 : 200, execution); return;
      }
      if (options.demo && (method === "GET" || method === "HEAD")) {
        const assetRoute = /^\/media\/([A-Za-z0-9_-]{1,80})(\/source)?$/.exec(url.pathname);
        if (assetRoute) {
          const asset = assets.get(assetRoute[1]!);
          if (!asset) throw new DemoRequestError(404, "ASSET_NOT_REGISTERED");
          const approved = sourceApproved(asset.sourceFilePath, config.sourceFile);
          if (assetRoute[2]) {
            if (!approved) throw new MediaError(404, "MEDIA_NOT_APPROVED");
            const bytes = await readVerifiedMedia(config.sourceRoot, asset.sourceFilePath, asset.sourceContentHash, asset.sourceSizeBytes);
            sendMedia(request, response, bytes, asset.sourceContentHash); return;
          }
          if (method !== "GET") throw new DemoRequestError(405, "METHOD_NOT_ALLOWED");
          const p = asset.policy;
          sendJson(response, 200, { assetId: asset.assetId, title: asset.title, owner: asset.owner,
            policy: { policyId: p.policyId, commercialUse: p.commercialUse, aiTraining: p.aiTraining, derivatives: p.derivatives,
              transcoding: p.transcoding, attributionRequired: p.attributionRequired, provenanceRequired: p.provenanceRequired },
            policyHash: asset.policyHash, sourceContentHash: asset.sourceContentHash, sourceSizeBytes: asset.sourceSizeBytes, hashAlgorithm: "sha256",
            sourceMediaUrl: approved ? `/media/${asset.assetId}/source` : null }); return;
        }
        const runRoute = /^\/executions\/([0-9a-f-]{36})(\/output)?$/i.exec(url.pathname);
        if (runRoute && REQUEST_ID.test(runRoute[1]!)) {
          const requestId = runRoute[1]!;
          if (runRoute[2]) {
            const output = executions.output(requestId);
            if (!output || !outputApproved(output.filePath, config.outputRoot, output.executionId)) throw new MediaError(404, "OUTPUT_NOT_AVAILABLE");
            const bytes = await readVerifiedMedia(config.outputRoot, output.filePath, output.outputContentHash, output.outputSizeBytes);
            sendMedia(request, response, bytes, output.outputContentHash); return;
          }
          if (method !== "GET") throw new DemoRequestError(405, "METHOD_NOT_ALLOWED");
          const run = executions.get(requestId);
          if (!run) throw new DemoRequestError(404, "EXECUTION_NOT_FOUND");
          sendJson(response, 200, run); return;
        }
        if (Object.hasOwn(FRONTEND_FILES, url.pathname)) {
          const file = await readFrontendFile(config.frontendRoot, url.pathname);
          response.writeHead(200, { "Content-Type": file.contentType, "Content-Length": file.bytes.length, "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'" });
          response.end(method === "HEAD" ? undefined : file.bytes); return;
        }
      }
      throw new DemoRequestError(404, "ROUTE_NOT_FOUND");
    } catch (error) {
      const known = error instanceof DemoRequestError || error instanceof MediaError;
      sendJson(response, known ? error.statusCode : 500, { error: known ? error.code : "INTERNAL_ERROR" });
    }
  });
  return { server, assets, executions };
}

if (require.main === module) {
  const demo = process.argv.includes("--demo");
  const { server } = createApiServer({ demo });
  server.listen(PORT, "127.0.0.1", () => console.log(`RelayStream Rights API listening on http://127.0.0.1:${PORT}${demo ? " (demo transport)" : ""}`));
}
