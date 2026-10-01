import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { executeAuthorizedTransformation, type ExecutionResult } from "./index";
import { registerMedia, type Permission } from "./register-media";
import {
  createProvenanceProof, createProvenanceV2Proof, hashProvenanceRecord,
  serializeProvenanceRecord, verifyProvenanceProof, ProvenanceError,
  type CompletedMediaProcessing, type LegacyProvenanceRecord, type ProvenanceV2Record,
} from "./provenance";
import { verifyOutputContent } from "./verify-output";

type Success = Extract<ExecutionResult, { status: "processed" }>;
const sourceFixture = path.resolve("test-media/relaystream-demo.mp4");
let root: string;
let success: Success;

function register(sourceFilePath: string, assetId: string, permission: Permission = "allow") {
  const log = console.log;
  console.log = () => {};
  try {
    return registerMedia({
      assetId, title: "Provenance v2 example", owner: "RelayStream",
      sourceUri: "local://relaystream-demo.mp4", sourceFilePath,
      policy: {
        policyId: `policy-${assetId}`, commercialUse: "deny", aiTraining: "deny",
        derivatives: "deny", transcoding: permission, attributionRequired: true, provenanceRequired: true,
      },
    });
  } finally {
    console.log = log;
  }
}

function assertNoProvenance(result: ExecutionResult) {
  assert.notEqual(result.status, "processed");
  assert.equal(result.provenanceCreated, false);
  assert.equal(result.provenance, null);
  assert.equal(result.proof, null);
  assert.equal("provenanceHash" in result, false);
  assert.equal(result.solanaAnchored, false);
  assert.equal(result.royaltyEventCreated, false);
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relaystream-provenance-test-"));
  const result = await executeAuthorizedTransformation(
    register(sourceFixture, "provenance-example"), "transcoding", "derived-example",
    { outputDirectory: path.join(root, "successful-output") },
  );
  if (result.status !== "processed") assert.fail(JSON.stringify(result));
  success = result;
});

after(async () => {
  if (!root) return;
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  await fs.rm(root, { recursive: true, force: true });
});

test("ALLOW returns immutable v2 provenance, a verified proof and independently matching output bytes", async (t) => {
  assert.equal(success.provenanceCreated, true);
  assert.equal(success.provenance.schemaVersion, 2);
  assert.equal(success.proof.record, success.provenance);
  assert.equal(success.solanaAnchored, false);
  assert.equal(success.royaltyEventCreated, false);
  assert.equal(success.provenance.executionId, success.executionId);
  assert.equal(success.provenance.sourceAssetId, success.authorization.assetId);
  assert.equal(success.provenance.sourceContentHash, success.authorization.sourceContentHash);
  assert.equal(success.provenance.policyHash, success.authorization.registeredPolicyHash);
  assert.equal(success.provenance.owner, success.authorization.owner);
  assert.equal(success.provenance.action, success.authorization.action);
  assert.equal(verifyProvenanceProof(success.proof), true);
  assert.equal(success.proof.provenanceHash, hashProvenanceRecord(success.provenance));
  const bytes = await fs.readFile(success.processingResult.outputFilePath);
  const independentHash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(independentHash, success.provenance.outputContentHash);
  assert.equal(bytes.length, success.provenance.outputSizeBytes);
  const verified = await verifyOutputContent(success.processingResult.outputFilePath, success.provenance);
  assert.equal(verified.verified, true);
  assert.equal(verified.computedHash, independentHash);
  t.diagnostic(`PROVENANCE_V2_EXAMPLE ${JSON.stringify({ provenance: success.provenance, proof: success.proof, independentOutputVerification: verified, independentlyHashedOutput: independentHash, solanaAnchored: false, royaltyEventCreated: false })}`);
});

test("changing output bytes without changing file size fails independent output verification", async (t) => {
  const bytes = await fs.readFile(success.processingResult.outputFilePath);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  const tamperedPath = path.join(root, "tampered-output.mp4");
  await fs.writeFile(tamperedPath, bytes);
  const verified = await verifyOutputContent(tamperedPath, success.provenance);
  assert.equal(verified.verified, false);
  assert.equal(verified.actualSizeBytes, success.provenance.outputSizeBytes);
  assert.notEqual(verified.computedHash, success.provenance.outputContentHash);
  assert.equal(verifyProvenanceProof(success.proof), true);
  t.diagnostic(`TAMPERED_OUTPUT_VERIFICATION ${JSON.stringify(verified)}`);
});

test("changing committed processing metadata fails provenance-hash verification", (t) => {
  const altered = {
    ...success.provenance,
    processing: { ...success.provenance.processing, height: success.provenance.processing.height + 2 },
  };
  const computedHash = hashProvenanceRecord(altered);
  assert.notEqual(computedHash, success.proof.provenanceHash);
  assert.equal(verifyProvenanceProof({ ...success.proof, record: altered }), false);
  t.diagnostic(`TAMPERED_METADATA_VERIFICATION ${JSON.stringify({ verified: false, expectedHash: success.proof.provenanceHash, computedHash })}`);
});

test("every committed leaf, including profile parameters and timestamps, affects the proof", () => {
  function leaves(value: unknown, prefix: string[] = []): string[][] {
    if (value !== null && typeof value === "object") {
      return Object.entries(value).flatMap(([key, child]) => leaves(child, [...prefix, key]));
    }
    return [prefix];
  }
  for (const keys of leaves(success.provenance)) {
    const altered = structuredClone(success.provenance);
    let parent = altered as unknown as Record<string, unknown>;
    for (const key of keys.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    const key = keys[keys.length - 1]!;
    const original = parent[key];
    parent[key] = typeof original === "number" ? original + 1 : typeof original === "boolean" ? !original : `${original}-changed`;
    assert.equal(verifyProvenanceProof({ ...success.proof, record: altered }), false, keys.join("."));
  }
});

test("v2 serialization and hashing ignore input object property insertion order", () => {
  function reverse(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reverse);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverse(child)]));
    }
    return value;
  }
  const reordered = reverse(success.provenance) as ProvenanceV2Record;
  assert.equal(serializeProvenanceRecord(reordered), serializeProvenanceRecord(success.provenance));
  assert.equal(hashProvenanceRecord(reordered), success.proof.provenanceHash);
});

test("records, nested metadata, profiles and proofs are frozen and detached from processor objects", async () => {
  const input = structuredClone(success);
  const proof = await createProvenanceV2Proof(input);
  assert.equal(proof.provenanceHash, success.proof.provenanceHash);
  for (const object of [proof, proof.record, proof.record.processing, proof.record.processing.profile]) assert.equal(Object.isFrozen(object), true);
  assert.equal(Reflect.set(proof.record, "owner", "Changed owner"), false);
  assert.equal(Reflect.set(proof.record.processing, "height", 999), false);
  assert.equal(Reflect.set(proof.record.processing.profile, "crf", 99), false);
  input.processingResult.processing.height += 2;
  assert.equal(proof.record.processing.height, success.provenance.processing.height);
  assert.equal(verifyProvenanceProof(proof), true);
});

test("legacy records retain their exact original canonical bytes and known SHA-256", () => {
  const legacy: LegacyProvenanceRecord = {
    provenanceId: "prov-legacy-source-legacy-derived", sourceAssetId: "legacy-source",
    derivedAssetId: "legacy-derived", policyId: "legacy-policy", policyHash: "b".repeat(64),
    action: "transcoding", owner: "Legacy Publisher", sourceContentHash: "a".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const originalBytes = '{"provenanceId":"prov-legacy-source-legacy-derived","sourceAssetId":"legacy-source","derivedAssetId":"legacy-derived","policyId":"legacy-policy","policyHash":"' + "b".repeat(64) + '","action":"transcoding","owner":"Legacy Publisher","sourceContentHash":"' + "a".repeat(64) + '","createdAt":"2026-01-01T00:00:00.000Z"}';
  const originalHash = "481a372144fb0e8423073caf0442477778fda4240d577ffd5625366e2a4ce720";
  assert.equal(serializeProvenanceRecord(legacy), originalBytes);
  assert.equal(hashProvenanceRecord(legacy), originalHash);
  assert.equal(hashProvenanceRecord({ ...legacy, schemaVersion: 1 }), originalHash);
  assert.equal(verifyProvenanceProof(createProvenanceProof(legacy)), true);
});

test("the v2 factory rejects blocked, unauthorized and mismatched completion snapshots", async () => {
  const altered: CompletedMediaProcessing[] = [
    { ...success, status: "blocked" } as unknown as CompletedMediaProcessing,
    { ...success, processingCompleted: false } as unknown as CompletedMediaProcessing,
    { ...success, authorization: { ...success.authorization, authorized: false, decision: "deny" } },
    { ...success, authorization: { ...success.authorization, policyIntegrityValid: false } },
    { ...success, authorization: { ...success.authorization, currentPolicyHash: "0".repeat(64) } },
    { ...success, authorization: { ...success.authorization, sourceContentHash: "0".repeat(64) } },
    { ...success, executionId: "wrong-execution" },
  ];
  for (const input of altered) {
    await assert.rejects(createProvenanceV2Proof(input), (error: unknown) => error instanceof ProvenanceError && error.code === "INVALID_COMPLETION");
  }
});

test("every blocked or failed workflow path returns zero provenance records and hashes", async (t) => {
  async function caseAsset(_context: TestContext, id: string, permission: Permission = "allow") {
    const source = path.join(root, `${id}.mp4`);
    await fs.copyFile(sourceFixture, source);
    return { source, asset: register(source, id, permission), outputDirectory: path.join(root, `${id}-output`) };
  }
  await t.test("DENY: zero processor invocations and no provenance", async (sub) => {
    const { asset, outputDirectory } = await caseAsset(sub, "deny", "deny");
    const processor = sub.mock.fn(async () => { throw new Error("Must not execute."); });
    const result = await executeAuthorizedTransformation(asset, "transcoding", "derived", { outputDirectory }, { processor });
    assert.equal(result.status, "blocked"); assert.equal(processor.mock.callCount(), 0); assertNoProvenance(result);
  });
  await t.test("policy integrity: zero processor invocations and no provenance", async (sub) => {
    const { asset, outputDirectory } = await caseAsset(sub, "integrity", "deny");
    asset.policy.transcoding = "allow";
    const processor = sub.mock.fn(async () => { throw new Error("Must not execute."); });
    const result = await executeAuthorizedTransformation(asset, "transcoding", "derived", { outputDirectory }, { processor });
    assert.equal(result.status, "blocked"); assert.equal(processor.mock.callCount(), 0); assertNoProvenance(result);
  });
  await t.test("source mismatch: zero processor invocations and no provenance", async (sub) => {
    const { source, asset, outputDirectory } = await caseAsset(sub, "source-mismatch");
    await fs.appendFile(source, "changed");
    const processor = sub.mock.fn(async () => { throw new Error("Must not execute."); });
    const result = await executeAuthorizedTransformation(asset, "transcoding", "derived", { outputDirectory }, { processor });
    assert.equal(result.status, "failed"); assert.equal(processor.mock.callCount(), 0); assertNoProvenance(result);
  });
  await t.test("real FFmpeg failure creates no provenance", async (sub) => {
    const source = path.join(root, "bad-media.mp4");
    await fs.writeFile(source, "Not media.");
    const result = await executeAuthorizedTransformation(register(source, "bad-media"), "transcoding", "derived", { outputDirectory: path.join(root, "bad-media-output") });
    if (result.status !== "failed") assert.fail("Expected an FFmpeg failure.");
    assert.equal(result.error.code, "PROCESS_FAILED"); assertNoProvenance(result);
  });
  await t.test("real adapter timeout creates no provenance", async (sub) => {
    const { asset, outputDirectory } = await caseAsset(sub, "timeout");
    const result = await executeAuthorizedTransformation(asset, "transcoding", "derived", { outputDirectory, processorOptions: { timeoutMs: 1 } });
    if (result.status !== "failed") assert.fail("Expected a timeout.");
    assert.equal(result.error.code, "TIMEOUT"); assertNoProvenance(result);
  });
  await t.test("corruption after processing is detected before any record is constructed", async (sub) => {
    const { asset, outputDirectory } = await caseAsset(sub, "invalid-output");
    const output = structuredClone(success.processingResult);
    output.outputFilePath = path.join(root, "corrupted-output.mp4");
    const bytes = await fs.readFile(success.processingResult.outputFilePath);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await fs.writeFile(output.outputFilePath, bytes);
    const result = await executeAuthorizedTransformation(asset, "transcoding", "derived", { outputDirectory }, { processor: async () => output });
    if (result.status !== "failed") assert.fail("Expected output verification failure.");
    assert.equal(result.stage, "provenance"); assert.equal(result.error.code, "OUTPUT_VERIFICATION_FAILED"); assertNoProvenance(result);
  });
  await t.test("invalid observed metadata creates no provenance", async (sub) => {
    const { asset, outputDirectory } = await caseAsset(sub, "invalid-metadata");
    const output = structuredClone(success.processingResult);
    output.processing.durationMs = 0;
    const result = await executeAuthorizedTransformation(asset, "transcoding", "derived", { outputDirectory }, { processor: async () => output });
    if (result.status !== "failed") assert.fail("Expected metadata validation failure.");
    assert.equal(result.error.code, "INVALID_COMPLETION"); assertNoProvenance(result);
  });
  await t.test("unreadable completed output creates no provenance", async (sub) => {
    const { asset, outputDirectory } = await caseAsset(sub, "missing-output");
    const output = structuredClone(success.processingResult);
    output.outputFilePath = path.join(root, "does-not-exist.mp4");
    const result = await executeAuthorizedTransformation(asset, "transcoding", "derived", { outputDirectory }, { processor: async () => output });
    if (result.status !== "failed") assert.fail("Expected output read failure.");
    assert.equal(result.error.code, "OUTPUT_VERIFICATION_FAILED"); assertNoProvenance(result);
  });
});

test("silent-video provenance explicitly commits audioCodec:null", async () => {
  const silent = path.join(root, "silent.mp4");
  await promisify(execFile)(process.env.FFMPEG_PATH ?? "ffmpeg", [
    "-nostdin", "-v", "error", "-n", "-i", sourceFixture, "-map", "0:v:0", "-c:v", "copy", "-an", silent,
  ], { windowsHide: true });
  const result = await executeAuthorizedTransformation(register(silent, "silent"), "transcoding", "silent-derived", { outputDirectory: path.join(root, "silent-output") });
  if (result.status !== "processed") assert.fail(JSON.stringify(result));
  assert.equal(result.provenance.processing.audioCodec, null);
  assert.equal(verifyProvenanceProof(result.proof), true);
  assert.equal((await verifyOutputContent(result.processingResult.outputFilePath, result.provenance)).verified, true);
});
