import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { executeAuthorizedTransformation } from "./index";
import { registerMedia } from "./register-media";
import { createDevnetConnection, getDevnetAuthority, provenanceMemo } from "./anchor-provenance";
import { verifyProvenanceOnChain } from "./verify-provenance";
import { verifyProvenanceProof } from "./provenance";

test("opt-in: fresh real Devnet anchor of processed Provenance v2, independently fetched and exactly verified", {
  skip: process.env.RUN_DEVNET_INTEGRATION !== "1", timeout: 120_000,
}, async t => {
  // Retain the media and receipt even on anchoring failure for diagnosis/reconciliation.
  const directory = process.env.RELAYSTREAM_DEVNET_ARTIFACT_DIRECTORY
    ? path.resolve(process.env.RELAYSTREAM_DEVNET_ARTIFACT_DIRECTORY)
    : await fs.mkdtemp(path.join(os.tmpdir(), "relaystream-devnet-integration-"));
  await fs.mkdir(directory, { recursive: true });
  const receiptPath = path.join(directory, "devnet-execution-receipt.json");
  const authority = getDevnetAuthority();
  const asset = registerMedia({
    assetId: "relaystream-devnet-checkpoint-4", title: "Checkpoint 4 fresh Devnet test", owner: "RelayStream",
    sourceUri: "local://relaystream-demo.mp4", sourceFilePath: path.resolve("test-media/relaystream-demo.mp4"),
    policy: { policyId: "checkpoint-4-transcoding", commercialUse: "deny", aiTraining: "deny", derivatives: "deny",
      transcoding: "allow", attributionRequired: true, provenanceRequired: true },
  });
  const result = await executeAuthorizedTransformation(asset, "transcoding", "checkpoint-4-derived", {
    outputDirectory: directory, royaltyLedgerDirectory: path.join(directory, "royalty-ledger"),
  });
  await fs.writeFile(receiptPath, JSON.stringify({ expectedAuthority: authority, execution: result }, null, 2));
  t.diagnostic(`DEVNET_EXECUTION_RECEIPT ${receiptPath}`);
  if (result.status !== "processed") assert.fail(JSON.stringify(result));
  assert.equal(result.provenanceCreated, true); assert.equal(verifyProvenanceProof(result.proof), true);
  assert.equal(result.solanaAnchored, true); assert.equal(result.royaltyEventCreated, true);
  assert.equal(result.fundsTransferred, false);
  assert.equal(result.anchor.expectedAuthority, authority);
  assert.equal(result.anchor.submission?.provenanceHash, result.proof.provenanceHash);

  // Separate Connection and RPC fetch, independent of the workflow's submission and verifier.
  const independent = await verifyProvenanceOnChain(result.solanaSignature, result.provenance, authority, createDevnetConnection());
  assert.equal(independent.verified, true, JSON.stringify(independent));
  assert.equal(independent.onChainMemo, provenanceMemo(result.proof.provenanceHash, 2));
  assert.equal(independent.computedHash, result.proof.provenanceHash);
  assert.equal(independent.verifiedAuthority, authority);
  const outputHash = createHash("sha256").update(await fs.readFile(result.processingResult.outputFilePath)).digest("hex");
  assert.equal(outputHash, result.provenance.outputContentHash);
  const receipt = { expectedAuthority: authority, execution: result, independentVerification: independent, independentlyHashedOutput: outputHash };
  await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  t.diagnostic(`FRESH_DEVNET_RESULT ${JSON.stringify({ provenanceHash: result.proof.provenanceHash,
    signature: result.solanaSignature, independentVerification: independent, outputHash, receiptPath, royaltyEventCreated: result.royaltyEventCreated, fundsTransferred: false })}`);
});
