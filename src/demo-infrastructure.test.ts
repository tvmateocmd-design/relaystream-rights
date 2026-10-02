import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { before, after, test, type TestContext } from "node:test";
import { createApiServer, type ApiOptions } from "./api";
import { bootstrapDemo, DEMO_ASSET_ID, DEMO_POLICY } from "./demo-config";
import { DemoExecutions, DemoRequestError, type DemoRequest } from "./demo-executions";
import { executeAuthorizedTransformation, type ExecutionDependencies, type ExecutionOptions } from "./index";
import { localAnchorDependencies } from "./anchor-test-support";
import { AnchorError } from "./anchor-provenance";
import { hashRightsPolicy, registerMedia, type RegisteredMediaAsset } from "./register-media";
import { createProvenanceV2Proof, verifyProvenanceProof } from "./provenance";
import { hashRoyaltyEvent } from "./royalties";
import { readFrontendFile, readVerifiedMedia } from "./media-serving";
import { transcodeMedia, type TranscodeResult } from "./transcode-media";

let root: string;
let output: TranscodeResult;
let asset: RegisteredMediaAsset;
const silent = <T>(work: () => T): T => { const log = console.log; console.log = () => {}; try { return work(); } finally { console.log = log; } };
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relaystream-demo-infrastructure-"));
  await fs.mkdir(path.join(root, "test-media"));
  await fs.copyFile(path.resolve("test-media/relaystream-demo.mp4"), path.join(root, "test-media/relaystream-demo.mp4"));
  asset = silent(() => bootstrapDemo(new Map(), root));
  output = await transcodeMedia({ sourceFilePath: asset.sourceFilePath, expectedSourceContentHash: asset.sourceContentHash,
    outputDirectory: path.join(root, "generated-media") });
});
after(async () => {
  if (!root) return;
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  await fs.rm(root, { recursive: true, force: true });
});
function dependencies(): ExecutionDependencies { return { processor: async () => structuredClone(output), ...localAnchorDependencies() }; }
function request(action: DemoRequest["action"] = "transcoding"): DemoRequest {
  return { requestId: randomUUID(), assetId: DEMO_ASSET_ID, action, derivedAssetId: "derived-demo", usageAmount: "100.00" };
}
async function startServer(t: TestContext, options: ApiOptions = {}) {
  const api = silent(() => createApiServer({ demo: true, workspaceRoot: root, dependencies: dependencies(), ...options }));
  api.server.listen(0, "127.0.0.1"); await once(api.server, "listening");
  const address = api.server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { api.server.closeAllConnections(); await new Promise<void>((resolve, reject) => api.server.close(error => error ? reject(error) : resolve())); });
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + route, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  return { ...api, base, post };
}
async function finish(api: Awaited<ReturnType<typeof startServer>>, body: DemoRequest) {
  const response = await api.post("/actions/execute?async=1", body); assert.equal(response.status, 202);
  await api.executions.wait(body.requestId);
  const fetched = await fetch(`${api.base}/executions/${body.requestId}`); assert.equal(fetched.status, 200);
  return await fetched.json() as any;
}
function rawGet(base: string, pathname: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = new URL(base);
    http.get({ hostname: url.hostname, port: url.port, path: pathname, headers }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
    }).on("error", reject);
  });
}

test("explicit bootstrap registers the existing demonstrated fixture and policy without executing work", () => {
  assert.deepEqual(asset.policy, DEMO_POLICY); assert.equal(asset.policyHash, hashRightsPolicy(DEMO_POLICY));
  assert.equal(asset.assetId, DEMO_ASSET_ID); assert.equal(asset.sourceSizeBytes, 3503432);
  const assets = new Map([[asset.assetId, asset]]);
  assert.throws(() => bootstrapDemo(assets, root));
});

test("AI TRAINING reaches the shared executor: canonical blocked result and all observed dependency counts zero", async t => {
  const d = dependencies();
  const processor = t.mock.fn(d.processor);
  const anchor = t.mock.fn(d.anchor!);
  const verifyAnchor = t.mock.fn(d.verifyAnchor!);
  const getAuthority = t.mock.fn(d.getAuthority!);
  const royalty = t.mock.fn(async () => { throw new Error("Must never create royalty after DENY"); });
  const api = await startServer(t, { dependencies: { ...d, processor, anchor, verifyAnchor, getAuthority, createRoyalty: royalty } });
  const run = await finish(api, request("aiTraining"));
  assert.equal(run.result.status, "blocked"); assert.equal(run.result.reasonCode, "PERMISSION_DENIED");
  assert.equal(run.result.authorization.action, "aiTraining"); assert.equal(run.result.authorization.policyIntegrityValid, true);
  assert.equal(run.result.authorization.decision, "deny"); assert.equal(run.result.processorInvoked, false);
  assert.equal(run.result.processingResult, null); assert.equal(run.result.executionId, null);
  assert.equal(run.result.provenanceCreated, false); assert.equal(run.result.provenance, null); assert.equal(run.result.proof, null);
  assert.equal(run.result.solanaAnchored, false); assert.equal(run.result.anchor, null);
  assert.equal(run.result.royaltyEventCreated, false); assert.equal(run.result.royalty, null); assert.equal(run.result.fundsTransferred, false);
  assert.deepEqual(run.calls, { processor: 0, provenance: 0, anchor: 0, verifyAnchor: 0, royalty: 0, solana: 0 });
  for (const spy of [processor, anchor, verifyAnchor, getAuthority, royalty]) assert.equal(spy.mock.callCount(), 0);
  assert.deepEqual(run.milestones.map((e: any) => e.milestone), ["BLOCKED"]);
  assert.equal((await fetch(api.base + `/executions/${run.requestId}/output`)).status, 404);
  t.diagnostic(`CANONICAL_DENY ${JSON.stringify(run)}`);
});

test("synchronous legacy and demo execution preserve 403 DENY and safely fail allowed unsupported derivatives", async t => {
  for (const demo of [false, true]) {
    const api = await startServer(t, { demo, assets: demo ? new Map() : new Map([[asset.assetId, asset]]) });
    const denied = await api.post("/actions/execute", request("aiTraining"));
    assert.equal(denied.status, 403); assert.equal((await denied.json() as any).reasonCode, "PERMISSION_DENIED");
    const unsupported = await api.post("/actions/execute", request("derivatives"));
    assert.equal(unsupported.status, 422);
    const result = await unsupported.json() as any;
    assert.equal(result.error.code, "UNSUPPORTED_ACTION"); assert.equal(result.processorInvoked, false);
    assert.equal(result.provenanceCreated, false); assert.equal(result.solanaAnchored, false); assert.equal(result.royaltyEventCreated, false);
  }
});

test("non-demo synchronous callers retain their existing non-demo asset ID vocabulary", async t => {
  const legacy = { ...asset, assetId: "legacy:registered/video" };
  const api = await startServer(t, { demo: false, assets: new Map([[legacy.assetId, legacy]]) });
  const response = await api.post("/actions/execute", { assetId: legacy.assetId, derivedAssetId: "derived:legacy/video", action: "aiTraining" });
  assert.equal(response.status, 403); assert.equal((await response.json() as any).reasonCode, "PERMISSION_DENIED");
});

test("default workspace source serves verified bytes and real AI-training DENY without a signer read", async t => {
  const d = dependencies(); const getAuthority = t.mock.fn(d.getAuthority!);
  const api = await startServer(t, { workspaceRoot: process.cwd(), dependencies: { ...d, getAuthority } });
  const response = await fetch(api.base + `/media/${DEMO_ASSET_ID}/source`, { method: "HEAD" });
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-length"), "3503432");
  const denied = await finish(api, request("aiTraining")); assert.equal(denied.result.reasonCode, "PERMISSION_DENIED");
  assert.equal(getAuthority.mock.callCount(), 0);
});

test("actual successful milestones occur in evidence order with immutable notifications and real timestamps", async t => {
  const events: string[] = [];
  const result = await executeAuthorizedTransformation(asset, "transcoding", "derived-demo", {
    observer: event => {
      assert.equal(Object.isFrozen(event), true); assert.deepEqual(Object.keys(event), ["milestone", "observedAt"]);
      assert.equal(new Date(event.observedAt).toISOString(), event.observedAt); events.push(event.milestone);
    },
  }, dependencies());
  assert.equal(result.status, "processed");
  assert.deepEqual(events, ["AUTHORIZED", "PROCESSING", "OUTPUT_VERIFIED", "PROVENANCE_V2", "SOLANA_VERIFIED", "ROYALTY_ALLOCATED"]);
  const api = await startServer(t);
  const run = await finish(api, request());
  assert.deepEqual(run.milestones.map((e: any) => e.milestone), events);
  assert.deepEqual(run.milestones.map((e: any) => e.sequence), [1, 2, 3, 4, 5, 6]);
  assert.ok(run.milestones.every((e: any, i: number, all: any[]) => i === 0 || e.observedAt >= all[i - 1].observedAt));
  t.diagnostic(`MOCKED_ALLOW_MILESTONES ${JSON.stringify(run.milestones)}`);
});

test("throwing and asynchronously rejecting observers leave proof, anchor, allocation and DENY unchanged", async () => {
  const baseline = await executeAuthorizedTransformation(asset, "transcoding", "derived-demo", {}, dependencies());
  for (const observer of [() => { throw new Error("observer failure"); }, async () => { throw new Error("async observer failure"); }]) {
    const result = await executeAuthorizedTransformation(asset, "transcoding", "derived-demo", { observer }, dependencies());
    assert.equal(result.status, "processed"); assert.equal(result.proof?.provenanceHash, baseline.proof?.provenanceHash);
    assert.equal(result.solanaAnchored, true); assert.equal(result.royaltyAllocated, true); assert.equal(result.fundsTransferred, false);
    const deny = await executeAuthorizedTransformation(asset, "aiTraining", "derived-demo", { observer }, dependencies());
    assert.equal(deny.status, "blocked"); assert.equal(deny.processorInvoked, false);
  }
  await new Promise(resolve => setImmediate(resolve));
});

test("proof-verification failure emits no provenance/chain/allocation success milestone", async () => {
  const d = dependencies(); const milestones: string[] = [];
  const result = await executeAuthorizedTransformation(asset, "transcoding", "derived-demo", { observer: e => { milestones.push(e.milestone); } }, {
    ...d, createProof: async (...args) => {
      const proof = await createProvenanceV2Proof(...args); return { ...proof, provenanceHash: "0".repeat(64) };
    },
  });
  assert.equal(result.status, "failed"); assert.equal(result.provenanceCreated, false);
  assert.deepEqual(milestones, ["AUTHORIZED", "PROCESSING", "OUTPUT_VERIFIED"]);
});

test("observer cannot replace snapshotted configuration or dependencies through caller-owned objects", async () => {
  const d = dependencies();
  const options: ExecutionOptions = { usageAmount: "100.00", processorOptions: { timeoutMs: 120000 } };
  options.observer = () => {
    options.usageAmount = "1.00"; options.processorOptions!.timeoutMs = 1;
    d.processor = async () => { throw new Error("observer replacement must not run"); };
    d.anchor = async () => { throw new Error("observer replacement must not run"); };
  };
  const result = await executeAuthorizedTransformation(asset, "transcoding", "derived-demo", options, d);
  assert.equal(result.status, "processed");
  assert.equal(result.royalty?.event.usageAmountMinorUnits, 10000);
});

test("UUID casing aliases reuse one request rather than creating a new execution", async () => {
  const registry = new DemoExecutions(path.join(root, "generated-media"), dependencies());
  const first = request("aiTraining"); registry.start(first, asset); await registry.wait(first.requestId);
  const alias = registry.start({ ...first, requestId: first.requestId.toUpperCase() }, asset);
  assert.equal(alias.requestId, first.requestId); assert.equal(alias.milestones.length, 1);
});

test("identical duplicates during and after execution reuse the request; conflicting duplicates return 409", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const processor = t.mock.fn(async () => { await gate; return structuredClone(output); });
  const api = await startServer(t, { dependencies: { ...dependencies(), processor } });
  const body = request();
  assert.equal((await api.post("/actions/execute?async=1", body)).status, 202);
  assert.equal((await api.post("/actions/execute?async=1", body)).status, 202);
  assert.equal((await api.post("/actions/execute?async=1", { ...body, usageAmount: "101.00" })).status, 409);
  assert.equal((await api.post("/actions/execute?async=1", request())).status, 409);
  release(); await api.executions.wait(body.requestId);
  assert.equal((await api.post("/actions/execute?async=1", body)).status, 202);
  await fetch(`${api.base}/executions/${body.requestId}`);
  assert.equal(processor.mock.callCount(), 1);
  assert.equal((await api.post("/actions/execute?async=1", { ...body, action: "aiTraining" })).status, 409);
});

test("bounded registry retains idempotency entries and fails closed at capacity", async () => {
  const registry = new DemoExecutions(path.join(root, "generated-media"), dependencies(), 1);
  const first = request("aiTraining"); registry.start(first, asset); await registry.wait(first.requestId);
  assert.equal(registry.start(first, asset).requestId, first.requestId);
  assert.throws(() => registry.start(request("aiTraining"), asset), (e: unknown) => e instanceof DemoRequestError && e.statusCode === 429);
  const copy = registry.get(first.requestId)!; copy.calls.processor = 99;
  assert.equal(registry.get(first.requestId)!.calls.processor, 0);
});

test("unknown Solana submission is preserved without retry or royalty release; diagnostics are sanitized", async t => {
  const secret = "C:\\private\\devnet-keypair.json SECRET_SIGNER_MARKER";
  const anchor = t.mock.fn(async () => { throw new AnchorError(secret, "submission", null, "unknown"); });
  const royalty = t.mock.fn(async () => { throw new Error("must not run"); });
  const api = await startServer(t, { dependencies: { ...dependencies(), anchor, createRoyalty: royalty } });
  const body = request(); const run = await finish(api, body);
  assert.equal(run.result.anchor.transactionStatus, "unknown"); assert.equal(run.result.solanaAnchored, false);
  assert.equal(run.result.provenanceCreated, true); assert.equal(run.result.royaltyEventCreated, false);
  for (let i = 0; i < 3; i++) {
    await fetch(`${api.base}/executions/${body.requestId}`);
    assert.equal((await api.post("/actions/execute?async=1", body)).status, 202);
  }
  assert.equal(anchor.mock.callCount(), 1); assert.equal(royalty.mock.callCount(), 0);
  const text = JSON.stringify(run); assert.ok(!text.includes("SECRET_SIGNER_MARKER")); assert.ok(!text.includes(root));
  assert.ok(!text.includes("outputFilePath")); assert.ok(!text.includes("devnet-keypair"));
});

test("metadata and successful browser receipts expose public proof data without physical paths", async t => {
  const api = await startServer(t);
  const metadata = await fetch(api.base + `/media/${DEMO_ASSET_ID}`); assert.equal(metadata.status, 200);
  const text = await metadata.text(); assert.ok(!text.includes(root)); assert.ok(!text.includes("sourceFilePath"));
  assert.deepEqual(JSON.parse(text).policy, DEMO_POLICY);
  const run = await finish(api, request());
  const serialized = JSON.stringify(run);
  assert.ok(!serialized.includes(root)); assert.ok(!serialized.includes("outputFilePath")); assert.ok(!serialized.includes("cleanupWarning"));
  assert.equal(run.result.provenance.schemaVersion, 2);
  assert.equal(verifyProvenanceProof(run.result.proof), true);
  assert.equal(hashRoyaltyEvent(run.result.royalty.event).royaltyEventHash, run.result.royalty.proof.royaltyEventHash);
  assert.equal(run.result.anchor.verification.computedHash, run.result.proof.provenanceHash);
  assert.deepEqual(run.result.royalty.event.allocations.map((a: any) => a.amountMinorUnits), [6000, 2000, 1000, 1000]);
});

test("source and verified output support GET, HEAD, prefix/suffix/open ranges and reject malformed ranges", async t => {
  const api = await startServer(t); const run = await finish(api, request());
  for (const route of [`/media/${DEMO_ASSET_ID}/source`, run.outputMediaUrl]) {
    const full = await fetch(api.base + route); assert.equal(full.status, 200);
    const bytes = Buffer.from(await full.arrayBuffer());
    const expected = route.endsWith("source") ? asset.sourceContentHash : output.outputContentHash;
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected);
    assert.equal(full.headers.get("content-type"), "video/mp4");
    const head = await fetch(api.base + route, { method: "HEAD" }); assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(bytes.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
    for (const [range, start, end] of [["bytes=0-15", 0, 15], ["bytes=-16", bytes.length - 16, bytes.length - 1],
      [`bytes=${bytes.length - 16}-`, bytes.length - 16, bytes.length - 1], ["bytes=0-999999999", 0, bytes.length - 1]] as const) {
      const response = await fetch(api.base + route, { headers: { Range: range } }); assert.equal(response.status, 206);
      assert.equal(response.headers.get("content-range"), `bytes ${start}-${end}/${bytes.length}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
    }
    for (const range of ["bytes=0-1,4-5", "bytes=-0", "bytes=9-2", `bytes=${bytes.length}-`, "bytes=", "items=0-1", "bytes=9007199254740992-"]) {
      const response = await fetch(api.base + route, { headers: { Range: range } }); assert.equal(response.status, 416);
      assert.equal(response.headers.get("content-range"), `bytes */${bytes.length}`);
    }
    const ifRange = await fetch(api.base + route, { headers: { Range: "bytes=0-1", "If-Range": '"different"' } });
    assert.equal(ifRange.status, 200); await ifRange.arrayBuffer();
  }
});

test("raw, encoded and double-encoded traversal and filesystem query parameters are rejected", async t => {
  const api = await startServer(t);
  for (const pathname of ["/media/../source", "/media/%2e%2e/source", "/media/%252e%252e/source", "/media/a%2f..%2fsource",
    "/media/a%255c..%255csource", "/media/a\\..\\source", "/%00", "/media/x/source?path=C%3A%5Cprivate"]) {
    assert.equal((await rawGet(api.base, pathname)).status, 400, pathname);
  }
  assert.equal((await api.post("/actions/execute?async=1", { ...request(), sourceFilePath: "C:\\private" })).status, 400);
});

test("arbitrary registered files remain unservable and browser registration is disabled", async t => {
  const arbitrary = path.join(root, "private.txt"); await fs.writeFile(arbitrary, "PRIVATE_CONTENT_MARKER");
  const extra = silent(() => registerMedia({ assetId: "private-asset", title: "Private", owner: "Test", sourceUri: "local://private",
    sourceFilePath: arbitrary, policy: { ...DEMO_POLICY } }));
  const api = await startServer(t, { assets: new Map([[extra.assetId, extra]]) });
  const result = await fetch(api.base + "/media/private-asset/source"); assert.equal(result.status, 404);
  assert.ok(!(await result.text()).includes("PRIVATE_CONTENT_MARKER"));
  const metadata = await fetch(api.base + "/media/private-asset"); assert.equal((await metadata.json() as any).sourceMediaUrl, null);
  assert.equal((await api.post("/media/register", { sourceFilePath: arbitrary })).status, 403);
  await assert.rejects(readVerifiedMedia(path.join(root, "test-media"), arbitrary, extra.sourceContentHash, extra.sourceSizeBytes));
});

test("tampered source and output bytes fail verification before any media response", async t => {
  const api = await startServer(t); const run = await finish(api, request());
  for (const [filePath, route] of [[asset.sourceFilePath, `/media/${DEMO_ASSET_ID}/source`], [output.outputFilePath, run.outputMediaUrl]]) {
    const original = await fs.readFile(filePath);
    try {
      const changed = Buffer.from(original); changed[0] = changed[0]! ^ 1; await fs.writeFile(filePath, changed);
      const response = await fetch(api.base + route); assert.equal(response.status, 422);
      assert.equal((await response.json() as any).error, "MEDIA_INTEGRITY_FAILED");
      await fs.writeFile(filePath, original.subarray(0, original.length - 1));
      assert.equal((await fetch(api.base + route)).status, 422);
    } finally { await fs.writeFile(filePath, original); }
  }
});

test("partial outputs and adapter snapshots are never addressable, even if a mock completion points at one", async t => {
  const partial = path.join(path.dirname(output.outputFilePath), "output.partial.mp4"); await fs.copyFile(output.outputFilePath, partial);
  const api = await startServer(t, { dependencies: { ...dependencies(), processor: async () => ({ ...output, outputFilePath: partial }) } });
  const run = await finish(api, request());
  assert.equal(run.result.status, "processed"); // Trusted test double; route still enforces the adapter's final filename.
  assert.equal((await fetch(api.base + run.outputMediaUrl)).status, 404);
  for (const route of [`/generated-media/${output.executionId}/output.partial.mp4`, `/executions/${run.requestId}/source.mp4`, "/test-media/relaystream-demo.mp4"]) {
    assert.equal((await fetch(api.base + route)).status, 404);
  }
});

test("directory media is rejected as non-regular", async () => {
  await assert.rejects(readVerifiedMedia(root, path.join(root, "test-media"), asset.sourceContentHash, asset.sourceSizeBytes));
});

test("symlink/junction file and permitted-root escapes are rejected where OS supports them", async t => {
  const outside = path.join(root, "outside"); const links = path.join(root, "links");
  await fs.mkdir(outside); await fs.mkdir(links);
  const external = path.join(outside, "video.mp4"); await fs.copyFile(asset.sourceFilePath, external);
  const linked = path.join(links, "video.mp4");
  let supported = 0;
  try {
    await fs.symlink(external, linked, "file"); supported++;
    await assert.rejects(readVerifiedMedia(links, linked, asset.sourceContentHash, asset.sourceSizeBytes));
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e; t.diagnostic("File symlink creation unavailable; junction test still required."); }
  const junction = path.join(links, "escape");
  try {
    await fs.symlink(outside, junction, process.platform === "win32" ? "junction" : "dir"); supported++;
    await assert.rejects(readVerifiedMedia(links, path.join(junction, "video.mp4"), asset.sourceContentHash, asset.sourceSizeBytes));
    await assert.rejects(readVerifiedMedia(junction, path.join(junction, "video.mp4"), asset.sourceContentHash, asset.sourceSizeBytes));
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e; }
  if (!supported) t.skip("OS disallows symlinks and junctions.");
  else t.diagnostic(`Link escape mechanisms checked: ${supported}`);
});

test("static foundation serves explicit files only; no interface or directory route exists", async t => {
  const api = await startServer(t); assert.equal((await fetch(api.base + "/")).status, 404);
  const frontend = path.join(root, "public"); await fs.mkdir(frontend);
  await fs.writeFile(path.join(frontend, "app.mjs"), "// static serving test fixture only\n");
  await fs.writeFile(path.join(frontend, "secret.txt"), "STATIC_SECRET_MARKER");
  const approved = await fetch(api.base + "/app.mjs"); assert.equal(approved.status, 200);
  assert.equal(approved.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal((await fetch(api.base + "/secret.txt")).status, 404);
  assert.equal((await fetch(api.base + "/public/")).status, 404);
  await assert.rejects(readFrontendFile(frontend, "/secret.txt"));
});

test("demo rejects unexpected hosts, cross-origin writes, invalid actions/IDs and oversized bodies", async t => {
  const api = await startServer(t);
  assert.equal((await rawGet(api.base, "/health", { Host: "evil.example" })).status, 403);
  assert.equal((await api.post("/actions/execute?async=1", request("aiTraining"), { Origin: "https://evil.example" })).status, 403);
  for (const invalid of [{ ...request(), requestId: "../bad" }, { ...request(), action: "unknown" }, { ...request(), derivedAssetId: "../bad" }]) {
    assert.equal((await api.post("/actions/execute?async=1", invalid)).status, 400);
  }
  const oversized = await api.post("/actions/execute?async=1", { padding: "x".repeat(17000) }); assert.equal(oversized.status, 413);
  assert.equal((await fetch(api.base + "/actions/execute?async=1", { method: "POST", body: "null" })).status, 400);
});
