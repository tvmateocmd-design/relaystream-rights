import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { before, after, test } from "node:test";
import { executeAuthorizedTransformation, type ExecutionResult } from "./index";
import { registerMedia, type Permission } from "./register-media";
import { transcodeMedia, TranscodeError, type TranscodeResult } from "./transcode-media";
import { createProvenanceV2Proof, verifyProvenanceProof } from "./provenance";
import { AnchorError } from "./anchor-provenance";
import { localAnchorDependencies, TEST_SIGNATURE } from "./anchor-test-support";
import { createDemoRoyaltyRule, prepareRoyaltyRequest, createRoyaltyEvent, hashRoyaltyEvent, RoyaltyError } from "./royalties";
import { FileRoyaltyEventStore, InMemoryRoyaltyEventStore } from "./royalty-event-store";

type Success = Extract<ExecutionResult, { status: "processed" }>;
const sourceFixture = path.resolve("test-media/relaystream-demo.mp4");
let root: string;
let output: TranscodeResult;
let success: Success;

function register(id: string, permission: Permission = "allow", source = sourceFixture) {
  const log = console.log; console.log = () => {};
  try {
    return registerMedia({ assetId: id, title: "Royalty allocation test", owner: "RelayStream", sourceUri: "local://test", sourceFilePath: source,
      policy: { policyId: `policy-${id}`, commercialUse: "deny", aiTraining: "deny", derivatives: "deny", transcoding: permission,
        attributionRequired: true, provenanceRequired: true } });
  } finally { console.log = log; }
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relaystream-royalty-test-"));
  output = await transcodeMedia({ sourceFilePath: sourceFixture,
    expectedSourceContentHash: createHash("sha256").update(await fs.readFile(sourceFixture)).digest("hex"), outputDirectory: root });
  const result = await executeAuthorizedTransformation(register("non-demo-asset"), "transcoding", "derived", {},
    { processor: async () => output, ...localAnchorDependencies() });
  if (result.status !== "processed") assert.fail(JSON.stringify(result));
  success = result;
});
after(async () => {
  if (!root) return;
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  await fs.rm(root, { recursive: true, force: true });
});

test("verified anchor creates exactly one event bound to execution, asset, proof and signature, allocating 100 as 60/20/10/10", async t => {
  const store = new InMemoryRoyaltyEventStore();
  const events: string[] = [];
  const local = localAnchorDependencies();
  const createRoyalty = t.mock.fn(async (...args: Parameters<typeof createRoyaltyEvent>) => {
    assert.equal(args[0].solanaAnchored, true);
    assert.equal(args[0].anchor?.verification?.verified, true);
    assert.equal(verifyProvenanceProof(args[0].proof!), true);
    events.push("create-event-and-allocate"); return createRoyaltyEvent(...args);
  });
  const result = await executeAuthorizedTransformation(register("any-asset"), "transcoding", "derived", { usageAmount: 100 }, {
    ...local, royaltyStore: store, createRoyalty,
    processor: async () => { events.push("process"); return output; },
    createProof: async completed => { const proof = await createProvenanceV2Proof(completed); events.push("verified-provenance"); return proof; },
    anchor: async (...args) => { events.push("anchor"); return local.anchor!(...args); },
    verifyAnchor: async (...args) => { const verified = await local.verifyAnchor!(...args); events.push("independent-verification"); return verified; },
  });
  if (result.status !== "processed") assert.fail(JSON.stringify(result));
  assert.equal(createRoyalty.mock.callCount(), 1); assert.equal(store.size, 1);
  assert.equal(result.royaltyEventCreated, true); assert.equal(result.royaltyAllocated, true); assert.equal(result.fundsTransferred, false);
  const event = result.royalty.event;
  assert.equal(event.executionId, result.executionId); assert.equal(event.assetId, "any-asset");
  assert.equal(event.provenanceHash, result.proof.provenanceHash); assert.equal(event.solanaSignature, TEST_SIGNATURE);
  assert.deepEqual(event.allocations.map(a => a.amountMinorUnits), [6000, 2000, 1000, 1000]);
  assert.deepEqual(event.allocations.map(a => a.amount), ["60.00", "20.00", "10.00", "10.00"]);
  assert.equal(event.totalAllocatedMinorUnits, 10_000); assert.equal(event.totalAllocated, "100.00");
  assert.equal(event.fundsTransferred, false); assert.equal(event.allocationOnly, true);
  assert.ok(Date.parse(event.createdAt) >= Date.parse(result.provenance.processing.completedAt));
  assert.equal(Object.isFrozen(event), true); assert.equal(Object.isFrozen(event.allocations[0]), true);
  assert.deepEqual(events, ["process", "verified-provenance", "anchor", "independent-verification", "create-event-and-allocate"]);
});

test("small, fractional and maximum supported amounts conserve every minor unit with deterministic remainders", async t => {
  for (const amount of ["0.01", "0.03", "0.05", "0.07", "0.09", "0.29", "1.01", "12.37", "100.00", "90071992547409.91"]) {
    await t.test(amount, async () => {
      const prepared = prepareRoyaltyRequest(createDemoRoyaltyRule(success.assetId), success.assetId, amount);
      const receipt = await createRoyaltyEvent(success, prepared, new InMemoryRoyaltyEventStore());
      assert.equal(receipt.event.allocations.reduce((sum, a) => sum + BigInt(a.amountMinorUnits), 0n), BigInt(prepared.usageAmountMinorUnits));
      assert.equal(receipt.event.totalAllocatedMinorUnits, prepared.usageAmountMinorUnits);
      assert.equal(receipt.event.totalAllocated, amount);
      if (amount === "0.05") assert.deepEqual(receipt.event.allocations.map(a => a.amountMinorUnits), [3, 1, 1, 0]);
      if (amount === "0.03") assert.deepEqual(receipt.event.allocations.map(a => a.amountMinorUnits), [2, 1, 0, 0]);
    });
  }
});

test("basis-point percentages conserve exactly and reject percentages with greater precision", async () => {
  const rule = createDemoRoyaltyRule(success.assetId);
  rule.recipients = rule.recipients.slice(0, 3).map((r, i) => ({ ...r, percentage: i === 2 ? 33.34 : 33.33 }));
  const prepared = prepareRoyaltyRequest(rule, success.assetId, "0.01");
  const receipt = await createRoyaltyEvent(success, prepared, new InMemoryRoyaltyEventStore());
  assert.deepEqual(receipt.event.allocations.map(a => a.amountMinorUnits), [0, 0, 1]);
  rule.recipients[0]!.percentage = 33.333;
  assert.throws(() => prepareRoyaltyRequest(rule, success.assetId), RoyaltyError);
});

test("replaying the completed execution concurrently or after reopening the durable store reuses one immutable allocation", async () => {
  const directory = path.join(root, "durable-ledger");
  const prepared = prepareRoyaltyRequest(createDemoRoyaltyRule(success.assetId), success.assetId, 100);
  const receipts = await Promise.all(Array.from({ length: 16 }, () => createRoyaltyEvent(success, prepared, new FileRoyaltyEventStore(directory))));
  assert.equal(receipts.filter(r => r.created).length, 1);
  assert.equal(new Set(receipts.map(r => r.proof.royaltyEventHash)).size, 1);
  const reopened = await createRoyaltyEvent(success, prepared, new FileRoyaltyEventStore(directory));
  assert.equal(reopened.created, false); assert.deepEqual(reopened.event, receipts[0]!.event);
  assert.equal(Object.isFrozen(reopened.event), true); assert.equal(Object.isFrozen(reopened.event.allocations[0]), true);
  assert.equal((await fs.readdir(directory)).filter(name => name.endsWith(".json")).length, 1);
  assert.equal((await fs.readdir(directory)).some(name => name.endsWith(".tmp")), false);
  await assert.rejects(createRoyaltyEvent(success, prepareRoyaltyRequest(createDemoRoyaltyRule(success.assetId), success.assetId, 101),
    new FileRoyaltyEventStore(directory)), (e: unknown) => e instanceof RoyaltyError && e.code === "IDEMPOTENCY_CONFLICT");
  assert.equal((await createRoyaltyEvent(success, prepared, new FileRoyaltyEventStore(directory))).proof.royaltyEventHash, reopened.proof.royaltyEventHash);
});

test("memory-store replays also reuse the original event", async () => {
  const store = new InMemoryRoyaltyEventStore();
  const prepared = prepareRoyaltyRequest(createDemoRoyaltyRule(success.assetId), success.assetId);
  const receipts = await Promise.all(Array.from({ length: 8 }, () => createRoyaltyEvent(success, prepared, store)));
  assert.equal(store.size, 1); assert.equal(receipts.filter(r => r.created).length, 1);
  assert.equal(receipts[0]!.proof.royaltyEventHash, hashRoyaltyEvent(receipts[0]!.event).royaltyEventHash);
});

test("invalid rule or amount fails preflight with zero processing, anchoring and royalty calls", async t => {
  for (const invalid of ["wrong-asset", "bad-total", "duplicate", "zero", "negative", "precision", "nan", "overflow", "null"] as const) {
    await t.test(invalid, async sub => {
      const asset = register(`invalid-${invalid}`);
      if (invalid === "wrong-asset") asset.royaltyRule.assetId = "other-asset";
      if (invalid === "bad-total") asset.royaltyRule.recipients[0]!.percentage = 59;
      if (invalid === "duplicate") asset.royaltyRule.recipients.push({ ...asset.royaltyRule.recipients[0]! });
      const usageAmount = invalid === "zero" ? 0 : invalid === "negative" ? -1 : invalid === "precision" ? "0.001"
        : invalid === "nan" ? NaN : invalid === "overflow" ? "90071992547409.92" : invalid === "null" ? null as unknown as number : 100;
      const processor = sub.mock.fn(transcodeMedia);
      const anchor = sub.mock.fn(async () => { throw new Error("No anchor allowed"); });
      const createRoyalty = sub.mock.fn(createRoyaltyEvent);
      const store = new InMemoryRoyaltyEventStore();
      const result = await executeAuthorizedTransformation(asset, "transcoding", "derived", { usageAmount }, { processor, anchor, createRoyalty, royaltyStore: store });
      assert.equal(result.status, "failed"); assert.equal(result.royaltyEventCreated, false); assert.equal(result.fundsTransferred, false);
      assert.equal(processor.mock.callCount(), 0); assert.equal(anchor.mock.callCount(), 0); assert.equal(createRoyalty.mock.callCount(), 0); assert.equal(store.size, 0);
    });
  }
});

test("DENY and every source, processing, proof, Solana or unknown-anchor failure create zero royalty events", async t => {
  for (const failure of ["deny", "integrity", "source", "processing", "timeout", "output", "metadata", "provenance", "submission", "confirmation", "failed-tx", "verification", "wrong-authority", "wrong-hash", "unknown"] as const) {
    await t.test(failure, async sub => {
      let asset = register(`failure-${failure}`, failure === "deny" || failure === "integrity" ? "deny" : "allow");
      if (failure === "integrity") asset.policy.transcoding = "allow";
      if (failure === "source") {
        const source = path.join(root, "modified-source.mp4"); await fs.copyFile(sourceFixture, source);
        asset = register(`failure-${failure}`, "allow", source); await fs.appendFile(source, "changed");
      }
      const local = localAnchorDependencies();
      const store = new InMemoryRoyaltyEventStore();
      const createRoyalty = sub.mock.fn(createRoyaltyEvent);
      const result = await executeAuthorizedTransformation(asset, "transcoding", "derived", {}, {
        ...local, royaltyStore: store, createRoyalty,
        processor: async () => {
          if (failure === "processing") throw new Error("Processing failed");
          if (failure === "timeout") throw new TranscodeError("TIMEOUT", "Timeout");
          const result = structuredClone(output);
          if (failure === "output") result.outputContentHash = "0".repeat(64);
          if (failure === "metadata") result.processing.durationMs = 0;
          return result;
        },
        createProof: async completed => {
          const proof = await createProvenanceV2Proof(completed);
          return failure === "provenance" ? { ...proof, provenanceHash: "0".repeat(64) } : proof;
        },
        anchor: async (...args) => {
          if (failure === "submission" || failure === "unknown") throw new AnchorError("Unknown submission outcome", "submission", null, "unknown");
          if (failure === "confirmation") throw new AnchorError("Confirmation timed out", "confirmation", TEST_SIGNATURE, "unknown");
          if (failure === "failed-tx") throw new AnchorError("Failed transaction", "confirmation", TEST_SIGNATURE, "failed");
          return local.anchor!(...args);
        },
        verifyAnchor: async (...args) => {
          const verified = await local.verifyAnchor!(...args);
          return failure === "verification" ? { ...verified, verified: false }
            : failure === "wrong-authority" ? { ...verified, verifiedAuthority: "unexpected-authority" }
            : failure === "wrong-hash" ? { ...verified, computedHash: "0".repeat(64) } : verified;
        },
      });
      assert.notEqual(result.status, "processed"); assert.equal(result.royaltyEventCreated, false);
      assert.equal(result.royaltyAllocated, false); assert.equal(result.royalty, null); assert.equal(result.fundsTransferred, false);
      assert.equal(createRoyalty.mock.callCount(), 0); assert.equal(store.size, 0);
      if (failure === "unknown") assert.equal(result.anchor?.transactionStatus, "unknown");
    });
  }
});

test("royalty factory rejects receipts with changed proof, signature, execution, verification, or network", async () => {
  for (const field of ["hash", "signature", "execution", "asset", "anchor", "network", "authority", "unknown", "authorization-asset", "authorization-action", "authorization-policy"] as const) {
    const altered = structuredClone(success);
    if (field === "hash") altered.proof = { ...altered.proof, provenanceHash: "0".repeat(64) };
    if (field === "signature") altered.solanaSignature = "other-signature";
    if (field === "execution") altered.executionId = "other-execution";
    if (field === "asset") altered.assetId = "other-asset";
    if (field === "anchor") altered.anchor.verification!.verified = false;
    if (field === "network") altered.anchor.verification!.genesisHash = "mainnet";
    if (field === "authority") altered.anchor.verification!.verifiedAuthority = "other-authority";
    if (field === "unknown") altered.anchor.transactionStatus = "unknown";
    if (field === "authorization-asset") altered.authorization.assetId = "other-asset";
    if (field === "authorization-action") altered.authorization.action = "aiTraining";
    if (field === "authorization-policy") altered.authorization.policyId = "other-policy";
    const store = new InMemoryRoyaltyEventStore();
    await assert.rejects(createRoyaltyEvent(altered, prepareRoyaltyRequest(createDemoRoyaltyRule(altered.assetId), altered.assetId), store),
      (e: unknown) => e instanceof RoyaltyError && e.code === "UNVERIFIED_EXECUTION", field);
    assert.equal(store.size, 0);
  }
});

test("the registered rule and requested amount are snapshotted before asynchronous processing", async () => {
  const asset = register("snapshot");
  const options = { usageAmount: "1.01" };
  const pending = executeAuthorizedTransformation(asset, "transcoding", "derived", options, { processor: async () => output, ...localAnchorDependencies() });
  asset.royaltyRule.recipients[0]!.wallet = "changed-recipient";
  asset.royaltyRule.recipients[0]!.percentage = 1;
  options.usageAmount = "999.99";
  const result = await pending;
  if (result.status !== "processed") assert.fail(JSON.stringify(result));
  assert.equal(result.royalty.event.usageAmountMinorUnits, 101);
  assert.equal(result.royalty.event.allocations[0]!.percentage, 60);
  assert.notEqual(result.royalty.event.allocations[0]!.wallet, "changed-recipient");
});

test("ledger storage failure retains successful media, proof and anchor without claiming allocation", async () => {
  const result = await executeAuthorizedTransformation(register("store-error"), "transcoding", "derived", {}, {
    processor: async () => output, ...localAnchorDependencies(), royaltyStore: { record: async () => { throw new Error("Store unavailable"); } },
  });
  if (result.status !== "failed" || result.stage !== "royalty") assert.fail(JSON.stringify(result));
  assert.equal(result.processingCompleted, true); assert.equal(result.provenanceCreated, true); assert.equal(result.solanaAnchored, true);
  assert.equal(result.royaltyEventCreated, false); assert.equal(result.royaltyAllocated, false); assert.equal(result.fundsTransferred, false);
});

test("corrupted durable records fail closed instead of allowing a replacement allocation", async () => {
  const directory = path.join(root, "corrupt-ledger");
  const prepared = prepareRoyaltyRequest(createDemoRoyaltyRule(success.assetId), success.assetId);
  await createRoyaltyEvent(success, prepared, new FileRoyaltyEventStore(directory));
  const [name] = await fs.readdir(directory); assert.ok(name);
  const target = path.join(directory, name);
  const stored = JSON.parse(await fs.readFile(target, "utf8")); stored.event.allocations[0].amountMinorUnits++;
  await fs.writeFile(target, JSON.stringify(stored));
  await assert.rejects(createRoyaltyEvent(success, prepared, new FileRoyaltyEventStore(directory)), RoyaltyError);
  assert.equal((await fs.readdir(directory)).length, 1);
});
