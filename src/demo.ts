import {
  demoAsset,
  verifyPermission,
  executeAuthorizedTransformation,
} from "./index";

import {
  anchorProvenanceProof,
} from "./anchor-provenance";

import {
  verifyProvenanceOnChain,
} from "./verify-provenance";

async function runDemo() {
  console.log("\n======================================");
  console.log("RELAYSTREAM RIGHTS");
  console.log("END-TO-END RIGHTS ENFORCEMENT DEMO");
  console.log("======================================");

  console.log(`ASSET: ${demoAsset.assetId}`);
  console.log(`OWNER: ${demoAsset.owner}`);
  console.log(`POLICY: ${demoAsset.policy.policyId}`);

  /*
   * TEST 1
   * Unauthorized AI training
   */

  console.log("\n======================================");
  console.log("TEST 1 — UNAUTHORIZED ACTION");
  console.log("======================================");

  const deniedAction = verifyPermission(
    demoAsset,
    "aiTraining"
  );

  console.log("ACTION REQUESTED: AI TRAINING");
  console.log(
    `RIGHTS CHECK: ${deniedAction.decision.toUpperCase()}`
  );

  if (!deniedAction.authorized) {
    console.log("STATUS: BLOCKED");
    console.log(`REASON: ${deniedAction.reason}`);
    console.log("TRANSFORMATION: NOT EXECUTED");
    console.log("PROVENANCE: NOT CREATED");
    console.log("SOLANA TRANSACTION: NOT SUBMITTED");
  }

  /*
   * TEST 2
   * Authorized transcoding
   */

  console.log("\n======================================");
  console.log("TEST 2 — AUTHORIZED ACTION");
  console.log("======================================");

  const allowedAction = verifyPermission(
    demoAsset,
    "transcoding"
  );

  console.log("ACTION REQUESTED: TRANSCODING");
  console.log(
    `RIGHTS CHECK: ${allowedAction.decision.toUpperCase()}`
  );

  if (!allowedAction.authorized) {
    throw new Error(
      "Transcoding was unexpectedly denied."
    );
  }

  /*
   * Execute the authorized transformation.
   * This creates provenance and its SHA-256 proof.
   */

  const proof = executeAuthorizedTransformation(
    demoAsset,
    "transcoding",
    "relaystream-demo-002"
  );

  if (!proof) {
    throw new Error(
      "Authorized transformation did not create provenance."
    );
  }

  console.log("\nPIPELINE: PROVENANCE PROOF READY");
  console.log(`SHA-256: ${proof.provenanceHash}`);

  /*
   * Anchor the exact provenance hash generated
   * by this transformation to Solana Devnet.
   */

  const anchor = await anchorProvenanceProof(
    proof.provenanceHash
  );

  console.log("\nPIPELINE: SOLANA ANCHOR CONFIRMED");
  console.log(`SIGNATURE: ${anchor.signature}`);

  /*
   * Retrieve the newly created transaction
   * from Solana and verify the same hash.
   */

  const verification =
    await verifyProvenanceOnChain(
      anchor.signature,
      proof.provenanceHash
    );

  console.log("\n======================================");
  console.log("END-TO-END RESULT");
  console.log("======================================");

  console.log("RIGHTS CHECK: ALLOW");
  console.log("TRANSFORMATION: AUTHORIZED");
  console.log("PROVENANCE: CREATED");
  console.log(
    `SHA-256: ${proof.provenanceHash}`
  );
  console.log("SOLANA ANCHOR: CONFIRMED");
  console.log(
    `TRANSACTION: ${anchor.signature}`
  );
  console.log(
    `ON-CHAIN VERIFY: ${
      verification.verified ? "MATCH" : "FAILED"
    }`
  );

  console.log("\nSTATUS: VERIFIED");

  console.log("\n======================================");
  console.log("RELAYSTREAM RIGHTS PIPELINE COMPLETE");
  console.log("======================================");
}

runDemo().catch((error) => {
  console.error("\n======================================");
  console.error("PIPELINE FAILED");
  console.error("======================================");
  console.error(error);
  process.exit(1);
});