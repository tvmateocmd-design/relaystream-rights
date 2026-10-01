import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import {
  executeAuthorizedTransformation,
  type ExecutionDependencies,
  type ExecutionResult,
} from "./index";
import { hashRightsPolicy, registerMedia, type Permission } from "./register-media";
import { transcodeMedia } from "./transcode-media";
import { localAnchorDependencies } from "./anchor-test-support";

const run = promisify(execFile);

async function fixture(t: TestContext, permission: Permission) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "relaystream-authorization-test-"));
  t.after(async () => {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const sourcePath = path.join(directory, "source.mp4");
  await fs.copyFile(path.resolve("test-media/relaystream-demo.mp4"), sourcePath);
  const log = t.mock.method(console, "log", () => {});
  let asset;
  try {
    asset = registerMedia({
      assetId: `authorization-${permission}`,
      title: "Authorization processing test",
      owner: "RelayStream",
      sourceUri: "local://source.mp4",
      sourceFilePath: sourcePath,
      policy: {
        policyId: `policy-${permission}`,
        commercialUse: "deny", aiTraining: "deny", derivatives: "deny",
        transcoding: permission, attributionRequired: true, provenanceRequired: true,
      },
    });
  } finally {
    log.mock.restore();
  }
  return { asset, directory, outputDirectory: path.join(directory, "outputs") };
}

function assertNoDownstreamEffects(result: ExecutionResult) {
  assert.equal(result.solanaAnchored, result.status === "processed");
  assert.equal(result.royaltyEventCreated, result.status === "processed");
  assert.equal(result.fundsTransferred, false);
  assert.equal("provenanceHash" in result, false);
  assert.equal("record" in result, false);
  assert.equal(result.solanaSignature === null, result.status !== "processed");
  assert.equal(result.royalty === null, result.status !== "processed");
  if (result.status === "processed") {
    assert.equal(result.provenanceCreated, true);
    assert.equal(result.provenance.schemaVersion, 2);
    assert.equal(result.proof.record, result.provenance);
  } else {
    assert.equal(result.provenanceCreated, false);
    assert.equal(result.provenance, null);
    assert.equal(result.proof, null);
  }
}

async function assertNoOutput(outputDirectory: string) {
  await assert.rejects(fs.stat(outputDirectory), { code: "ENOENT" });
}

test("ALLOW invokes the real adapter once and returns validated output bytes and metadata", async (t) => {
  const { asset, outputDirectory } = await fixture(t, "allow");
  const processor = t.mock.fn(transcodeMedia);
  const result = await executeAuthorizedTransformation(
    asset, "transcoding", "derived-allow", { outputDirectory }, { processor, ...localAnchorDependencies() },
  );
  assert.equal(result.status, "processed");
  assert.equal(processor.mock.callCount(), 1);
  assertNoDownstreamEffects(result);
  if (result.status !== "processed") assert.fail("Expected real processing to complete.");
  assert.equal(result.authorization.authorized, true);
  assert.equal(result.authorization.policyIntegrityValid, true);
  assert.equal(result.processorInvoked, true);
  assert.equal(result.processingCompleted, true);
  assert.equal(result.executionId, result.processingResult.executionId);
  const output = result.processingResult;
  assert.equal(output.outputContentHash, createHash("sha256").update(await fs.readFile(output.outputFilePath)).digest("hex"));
  assert.equal(output.outputSizeBytes, (await fs.stat(output.outputFilePath)).size);
  assert.equal(output.sourceContentHash, asset.sourceContentHash);
  assert.equal(output.processing.width, 640);
  assert.equal(output.processing.height, 360);
  assert.equal(output.processing.videoCodec, "h264");
  assert.equal(output.processing.audioCodec, "aac");
  const probe = await run(process.env.FFPROBE_PATH ?? "ffprobe", [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", output.outputFilePath,
  ], { windowsHide: true });
  const observed = JSON.parse(probe.stdout);
  assert.deepEqual(observed.streams.map((stream: { codec_name: string }) => stream.codec_name), ["h264", "aac"]);
  assert.equal(observed.streams[0].width, 640);
  assert.equal(observed.streams[0].height, 360);
  assert.equal(Math.round(Number(observed.format.duration) * 1000), output.processing.durationMs);
  await run(process.env.FFMPEG_PATH ?? "ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-i", output.outputFilePath, "-f", "null", "-"], { windowsHide: true });
  t.diagnostic(`ALLOW_EXECUTION_RESULT ${JSON.stringify(result)}`);
});

test("DENY returns blocked with zero processor calls and no output directory", async (t) => {
  const { asset, outputDirectory } = await fixture(t, "deny");
  const processor = t.mock.fn(async () => { throw new Error("Denied processor must never be called."); });
  // A denied execution must not even attempt its source-read preflight.
  await fs.unlink(asset.sourceFilePath);
  const result = await executeAuthorizedTransformation(
    asset, "transcoding", "derived-deny", { outputDirectory }, { processor },
  );
  assert.equal(result.status, "blocked");
  assert.equal(processor.mock.callCount(), 0);
  assert.equal(result.authorization.decision, "deny");
  assert.equal(result.authorization.policyIntegrityValid, true);
  assert.equal(result.processorInvoked, false);
  assert.equal(result.processingCompleted, false);
  assert.equal(result.processingResult, null);
  assert.equal(result.executionId, null);
  if (result.status !== "blocked") assert.fail("Expected blocked execution.");
  assert.equal(result.reasonCode, "PERMISSION_DENIED");
  assertNoDownstreamEffects(result);
  await assertNoOutput(outputDirectory);
  t.diagnostic(`DENY_EXECUTION_RESULT ${JSON.stringify(result)}`);
});

test("changing a registered DENY policy to ALLOW fails integrity with zero processor calls", async (t) => {
  const { asset, outputDirectory } = await fixture(t, "deny");
  asset.policy.transcoding = "allow";
  const processor = t.mock.fn(async () => { throw new Error("Invalid policy must never reach processing."); });
  const result = await executeAuthorizedTransformation(
    asset, "transcoding", "derived-tampered-policy", { outputDirectory }, { processor },
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.authorization.policyIntegrityValid, false);
  assert.equal(result.authorization.authorized, false);
  assert.equal(processor.mock.callCount(), 0);
  assert.equal(result.processorInvoked, false);
  if (result.status !== "blocked") assert.fail("Expected blocked execution.");
  assert.equal(result.reasonCode, "POLICY_INTEGRITY_FAILED");
  assertNoDownstreamEffects(result);
  await assertNoOutput(outputDirectory);
});

test("modifying source bytes after registration fails before invoking the processor", async (t) => {
  const { asset, outputDirectory } = await fixture(t, "allow");
  const altered = await fs.readFile(asset.sourceFilePath);
  altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
  await fs.writeFile(asset.sourceFilePath, altered);
  const processor = t.mock.fn(async () => { throw new Error("Changed source must never reach processing."); });
  const result = await executeAuthorizedTransformation(
    asset, "transcoding", "derived-tampered-source", { outputDirectory }, { processor },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.authorization.authorized, true);
  assert.equal(result.authorization.policyIntegrityValid, true);
  assert.equal(processor.mock.callCount(), 0);
  assert.equal(result.processorInvoked, false);
  assert.equal(result.executionId, null);
  assert.equal(result.processingResult, null);
  if (result.status !== "failed") assert.fail("Expected source validation failure.");
  assert.equal(result.stage, "source_validation");
  assert.equal(result.error.code, "SOURCE_HASH_MISMATCH");
  assertNoDownstreamEffects(result);
  await assertNoOutput(outputDirectory);
});

test("asset, nested policy and processor configuration are captured before asynchronous work", async (t) => {
  const { asset, directory, outputDirectory } = await fixture(t, "allow");
  const registeredHash = asset.sourceContentHash;
  const registeredPolicyHash = asset.policyHash;
  const registeredPath = asset.sourceFilePath;
  const processor = t.mock.fn(transcodeMedia);
  const options = { outputDirectory, processorOptions: { timeoutMs: 120_000 } };
  const dependencies: ExecutionDependencies = { processor, ...localAnchorDependencies() };
  const pending = executeAuthorizedTransformation(asset, "transcoding", "derived-snapshot", options, dependencies);
  asset.policy.transcoding = "deny";
  asset.policy.policyId = "changed-policy";
  asset.policyHash = hashRightsPolicy(asset.policy);
  asset.sourceContentHash = "0".repeat(64);
  asset.sourceFilePath = path.join(directory, "missing.mp4");
  asset.assetId = "changed-asset";
  asset.owner = "changed-owner";
  options.outputDirectory = path.join(directory, "changed-output");
  options.processorOptions.timeoutMs = 1;
  dependencies.processor = async () => { throw new Error("Changed dependency must not be used."); };
  const result = await pending;
  assert.equal(result.status, "processed");
  assert.equal(processor.mock.callCount(), 1);
  assert.equal(result.assetId, "authorization-allow");
  assert.equal(result.authorization.policyId, "policy-allow");
  assert.equal(result.authorization.owner, "RelayStream");
  assert.equal(result.authorization.registeredPolicyHash, registeredPolicyHash);
  assert.equal(result.authorization.currentPolicyHash, registeredPolicyHash);
  if (result.status !== "processed") assert.fail("Expected processing and provenance to complete.");
  assert.equal(result.provenance.sourceAssetId, "authorization-allow");
  assert.equal(result.provenance.policyId, "policy-allow");
  assert.equal(result.provenance.policyHash, registeredPolicyHash);
  assert.equal(result.provenance.sourceContentHash, registeredHash);
  assert.equal(result.provenance.owner, "RelayStream");
  assert.equal(processor.mock.calls[0]?.arguments[0].sourceFilePath, registeredPath);
  assert.equal(processor.mock.calls[0]?.arguments[0].expectedSourceContentHash, registeredHash);
  assert.equal(processor.mock.calls[0]?.arguments[1]?.timeoutMs, 120_000);
  await assertNoOutput(options.outputDirectory);
  assertNoDownstreamEffects(result);
});

test("processor failure becomes a structured failed result without downstream work", async (t) => {
  const { asset, outputDirectory } = await fixture(t, "allow");
  const processor = t.mock.fn(async () => { throw new Error("Processor failure test."); });
  const result = await executeAuthorizedTransformation(
    asset, "transcoding", "derived-failure", { outputDirectory }, { processor },
  );
  assert.equal(processor.mock.callCount(), 1);
  assert.equal(result.status, "failed");
  assert.equal(result.processorInvoked, true);
  assert.equal(result.processingCompleted, false);
  if (result.status !== "failed") assert.fail("Expected structured processor failure.");
  assert.equal(result.stage, "processing");
  assert.equal(result.error.code, "PROCESSING_FAILED");
  assertNoDownstreamEffects(result);
  await assertNoOutput(outputDirectory);
});
