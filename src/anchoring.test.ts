import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { before, after, test } from "node:test";
import { PublicKey, TransactionMessage } from "@solana/web3.js";
import { executeAuthorizedTransformation, type ExecutionDependencies } from "./index";
import { registerMedia, type Permission } from "./register-media";
import { transcodeMedia, TranscodeError, type TranscodeResult } from "./transcode-media";
import { createProvenanceV2Proof, verifyProvenanceProof, hashProvenanceRecord, type LegacyProvenanceRecord, type ProvenanceV2Record } from "./provenance";
import { AnchorError, DEVNET_ENDPOINT, provenanceMemo } from "./anchor-provenance";
import { verifyProvenanceOnChain } from "./verify-provenance";
import { connectionFixture, localAnchorDependencies, TEST_AUTHORITY, TEST_SIGNATURE, transactionFixture } from "./anchor-test-support";

let root: string;
let output: TranscodeResult;
let record: ProvenanceV2Record;
const sourceFixture = path.resolve("test-media/relaystream-demo.mp4");

function asset(id: string, permission: Permission = "allow", source = sourceFixture) {
  const log = console.log;
  console.log = () => {};
  try {
    return registerMedia({ assetId: id, title: "Anchor test", owner: "RelayStream", sourceUri: "local://test",
      sourceFilePath: source, policy: { policyId: `policy-${id}`, commercialUse: "deny", aiTraining: "deny",
        derivatives: "deny", transcoding: permission, attributionRequired: true, provenanceRequired: true } });
  } finally { console.log = log; }
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relaystream-anchor-test-"));
  output = await transcodeMedia({ sourceFilePath: sourceFixture,
    expectedSourceContentHash: createHash("sha256").update(await fs.readFile(sourceFixture)).digest("hex"), outputDirectory: root });
  const result = await executeAuthorizedTransformation(asset("fixture"), "transcoding", "derived", {},
    { processor: async () => output, ...localAnchorDependencies() });
  if (result.status !== "processed") assert.fail(JSON.stringify(result));
  record = result.provenance;
});

after(async () => {
  if (!root) return;
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  await fs.rm(root, { recursive: true, force: true });
});

test("successful anchor receives the exact locally verified v2 hash after processing and provenance verification", async (t) => {
  const events: string[] = [];
  const local = localAnchorDependencies();
  let exactHash = "";
  const dependencies: ExecutionDependencies = {
    processor: async () => { events.push("processing"); return output; },
    createProof: async completed => {
      const proof = await createProvenanceV2Proof(completed);
      assert.equal(verifyProvenanceProof(proof), true);
      exactHash = proof.provenanceHash; events.push("verified-provenance"); return proof;
    },
    getAuthority: () => { events.push("authority"); return TEST_AUTHORITY; },
    anchor: t.mock.fn(async (hash, authority, version) => {
      events.push("anchor"); assert.equal(hash, exactHash); assert.equal(authority, TEST_AUTHORITY); assert.equal(version, 2);
      return local.anchor!(hash, authority, version);
    }),
    verifyAnchor: async (...args) => { events.push("independent-fetch"); return local.verifyAnchor!(...args); },
  };
  const result = await executeAuthorizedTransformation(asset("success"), "transcoding", "derived", {}, dependencies);
  assert.equal(result.status, "processed"); assert.equal(result.solanaAnchored, true);
  assert.equal(result.provenanceCreated, true); assert.equal(result.royaltyEventCreated, false);
  assert.equal(result.solanaSignature, TEST_SIGNATURE); assert.equal(result.anchor?.verification?.verified, true);
  assert.deepEqual(events, ["processing", "verified-provenance", "authority", "anchor", "independent-fetch"]);
});

test("every gate and proof failure makes zero calls to all Solana dependencies", async (t) => {
  for (const failure of ["deny", "integrity", "source", "processing", "timeout", "output", "metadata", "proof"] as const) {
    await t.test(failure, async sub => {
      let registered = asset(failure, failure === "deny" || failure === "integrity" ? "deny" : "allow");
      if (failure === "integrity") registered.policy.transcoding = "allow";
      if (failure === "source") {
        const source = path.join(root, "changed-source.mp4"); await fs.copyFile(sourceFixture, source);
        registered = asset(failure, "allow", source); await fs.appendFile(source, "modified");
      }
      const processor = sub.mock.fn(async () => {
        if (failure === "processing") throw new Error("Processing failed.");
        if (failure === "timeout") throw new TranscodeError("TIMEOUT", "Processor timed out.");
        const value = structuredClone(output);
        if (failure === "output") value.outputContentHash = "0".repeat(64);
        if (failure === "metadata") value.processing.durationMs = 0;
        return value;
      });
      const getAuthority = sub.mock.fn(() => { throw new Error("Authority must not be loaded."); });
      const anchor = sub.mock.fn(async () => { throw new Error("Must never anchor."); });
      const verifyAnchor = sub.mock.fn(async () => { throw new Error("Must never fetch."); });
      const createProof: typeof createProvenanceV2Proof = async completed => {
        const proof = await createProvenanceV2Proof(completed);
        return failure === "proof" ? { ...proof, provenanceHash: "0".repeat(64) } : proof;
      };
      const result = await executeAuthorizedTransformation(registered, "transcoding", "derived", {},
        { processor, createProof, getAuthority, anchor, verifyAnchor });
      assert.notEqual(result.status, "processed"); assert.equal(result.solanaAnchored, false);
      assert.equal(result.provenanceCreated, false); assert.equal(result.proof, null); assert.equal(result.anchor, null);
      assert.equal(result.royaltyEventCreated, false);
      assert.equal(getAuthority.mock.callCount(), 0); assert.equal(anchor.mock.callCount(), 0); assert.equal(verifyAnchor.mock.callCount(), 0);
      if (["deny", "integrity", "source"].some(value => value === failure)) assert.equal(processor.mock.callCount(), 0);
    });
  }
});

test("submission, confirmation and independent-verification failures preserve completed output and local proof", async (t) => {
  for (const failure of ["preflight", "submission", "confirmation", "transaction", "verification"] as const) {
    await t.test(failure, async () => {
      const local = localAnchorDependencies();
      const result = await executeAuthorizedTransformation(asset(failure), "transcoding", "derived", {}, {
        processor: async () => output, ...local,
        getAuthority: failure === "preflight" ? () => { throw new Error("Signer missing."); } : local.getAuthority!,
        anchor: async (...args) => {
          if (failure === "submission") throw new AnchorError("RPC submission error", "submission", null, "unknown");
          if (failure === "confirmation") throw new AnchorError("Confirmation timeout", "confirmation", TEST_SIGNATURE, "unknown");
          if (failure === "transaction") throw new AnchorError("Transaction failed", "confirmation", TEST_SIGNATURE, "failed");
          return local.anchor!(...args);
        },
        verifyAnchor: async (...args) => {
          const verified = await local.verifyAnchor!(...args);
          return failure === "verification" ? { ...verified, verified: false, reason: "Wrong Memo" } : verified;
        },
      });
      if (result.status !== "failed" || result.stage !== "anchor") assert.fail(JSON.stringify(result));
      assert.equal(result.provenanceCreated, true); assert.equal(verifyProvenanceProof(result.proof), true);
      assert.equal(result.processingCompleted, true); assert.equal(result.solanaAnchored, false); assert.equal(result.royaltyEventCreated, false);
      assert.equal(createHash("sha256").update(await fs.readFile(result.processingResult.outputFilePath)).digest("hex"), result.provenance.outputContentHash);
      assert.equal(result.solanaSignature, ["confirmation", "transaction", "verification"].some(value => value === failure) ? TEST_SIGNATURE : null);
      assert.equal(result.anchor.transactionStatus, failure === "preflight" ? "not_submitted" : failure === "transaction" ? "failed"
        : failure === "verification" ? "confirmed" : "unknown");
    });
  }
});

test("only the actual exact Memo and its expected signing authority verify", async (t) => {
  const memo = provenanceMemo(hashProvenanceRecord(record));
  for (const scenario of ["valid", "missing", "failed", "no-meta", "wrong-payload", "partial", "substring", "wrong-authority", "unsigned-memo", "wrong-program", "logs-only", "wrong-signature", "wrong-endpoint", "wrong-network", "rpc-error", "metadata-tamper", "v0"] as const) {
    await t.test(scenario, async sub => {
      const wrongKey = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
      const payload = scenario === "partial" ? memo.slice(0, -1) : scenario === "substring" ? `prefix${memo}suffix`
        : scenario === "wrong-payload" || scenario === "logs-only" ? provenanceMemo("0".repeat(64)) : memo;
      const tx = transactionFixture(payload, scenario === "wrong-authority" ? wrongKey : TEST_AUTHORITY,
        scenario !== "unsigned-memo", scenario === "wrong-program" ? new PublicKey(wrongKey) : undefined);
      if (scenario === "failed") tx.meta!.err = { InstructionError: [0, "InvalidInstructionData"] };
      if (scenario === "no-meta") tx.meta = null;
      if (scenario === "logs-only") tx.meta!.logMessages = [`Program log: ${memo}`];
      if (scenario === "wrong-signature") tx.transaction.signatures[0] = "different-signature";
      if (scenario === "v0") {
        const legacy = tx.transaction.message;
        const keys = legacy.getAccountKeys();
        tx.transaction.message = new TransactionMessage({ payerKey: keys.get(0)!, recentBlockhash: legacy.recentBlockhash,
          instructions: [{ programId: keys.get(1)!, keys: [{ pubkey: keys.get(0)!, isSigner: true, isWritable: false }], data: Buffer.from(memo) }] }).compileToV0Message();
        tx.version = 0;
      }
      const connection = connectionFixture(scenario === "missing" ? null : tx);
      const getTransaction = sub.mock.fn(connection.getTransaction);
      const candidate = scenario === "metadata-tamper" ? { ...record, owner: "Tampered" } : record;
      const result = await verifyProvenanceOnChain(TEST_SIGNATURE, candidate, TEST_AUTHORITY, {
        ...connection, rpcEndpoint: scenario === "wrong-endpoint" ? "https://api.mainnet-beta.solana.com" : DEVNET_ENDPOINT,
        getGenesisHash: scenario === "wrong-network" ? async () => "mainnet-genesis" : connection.getGenesisHash,
        getTransaction: scenario === "rpc-error" ? async () => { throw new Error("RPC unavailable"); } : getTransaction,
      });
      assert.equal(result.verified, scenario === "valid" || scenario === "v0", scenario);
      if (result.verified) {
        assert.equal(result.onChainMemo, memo); assert.equal(result.verifiedAuthority, TEST_AUTHORITY);
        assert.equal(result.transactionSucceeded, true);
        assert.deepEqual(getTransaction.mock.calls[0]?.arguments, [TEST_SIGNATURE, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      }
      if (scenario === "wrong-endpoint" || scenario === "wrong-network") assert.equal(getTransaction.mock.callCount(), 0);
    });
  }
});

test("legacy v1 Memo verification preserves old hashes while requiring the supplied trusted signer", async () => {
  const legacy: LegacyProvenanceRecord = { provenanceId: "legacy", sourceAssetId: "source", derivedAssetId: "derived",
    policyId: "policy", policyHash: "b".repeat(64), action: "transcoding", owner: "Owner", sourceContentHash: "a".repeat(64), createdAt: "2026-01-01T00:00:00.000Z" };
  const memo = provenanceMemo(hashProvenanceRecord(legacy), 1);
  const connection = connectionFixture(transactionFixture(memo, TEST_AUTHORITY, false));
  assert.equal((await verifyProvenanceOnChain(TEST_SIGNATURE, legacy, TEST_AUTHORITY, connection)).verified, true);
  assert.equal((await verifyProvenanceOnChain(TEST_SIGNATURE, legacy, new PublicKey(new Uint8Array(32).fill(9)).toBase58(), connection)).verified, false);
});

test("Memo construction rejects incomplete or noncanonical SHA-256 commitments", () => {
  for (const hash of ["abc", "A".repeat(64), "z".repeat(64), `${"a".repeat(64)}\n`]) assert.throws(() => provenanceMemo(hash));
});
