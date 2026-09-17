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
   * Execute authorized transformation.
   * Creates provenance record and SHA-256 proof.
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
   * Anchor the provenance proof to Solana Devnet.
   */

  const anchor = await anchorProvenanceProof(
    proof.provenanceHash
  );

  console.log("\nPIPELINE: SOLANA ANCHOR CONFIRMED");
  console.log(`SIGNATURE: ${anchor.signature}`);

  /*
   * TEST 3
   * Independently verify the ORIGINAL provenance record.
   *
   * The verifier receives the record itself.
   * It recomputes the SHA-256 fingerprint internally.
   */

  console.log("\n======================================");
  console.log("TEST 3 — ORIGINAL PROVENANCE RECORD");
  console.log("======================================");

  const verification =
    await verifyProvenanceOnChain(
      anchor.signature,
      proof.record
    );

  if (!verification.verified) {
    throw new Error(
      "Original provenance record failed verification."
    );
  }

  console.log("\nORIGINAL RECORD: VERIFIED");

  /*
   * TEST 4
   * Deliberately tamper with the provenance record.
   *
   * Only the owner field is changed.
   * Everything else remains identical.
   */

  console.log("\n======================================");
  console.log("TEST 4 — TAMPER DETECTION");
  console.log("======================================");

  const tamperedRecord = {
    ...proof.record,
    owner: "Tampered Owner",
  };

  console.log(`ORIGINAL OWNER: ${proof.record.owner}`);
  console.log(`TAMPERED OWNER: ${tamperedRecord.owner}`);

  const tamperedVerification =
    await verifyProvenanceOnChain(
      anchor.signature,
      tamperedRecord
    );

  console.log("\n======================================");
  console.log("TAMPER TEST RESULT");
  console.log("======================================");

  console.log(
    `ON-CHAIN VERIFY: ${
      tamperedVerification.verified
        ? "MATCH"
        : "MISMATCH"
    }`
  );

  if (tamperedVerification.verified) {
    throw new Error(
      "Tampered provenance record unexpectedly verified."
    );
  }

  console.log("TAMPER DETECTED: TRUE");

  /*
   * Final pipeline summary.
   */

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
  console.log("ORIGINAL RECORD VERIFY: MATCH");
  console.log("TAMPERED RECORD VERIFY: MISMATCH");
  console.log("TAMPER DETECTED: TRUE");

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