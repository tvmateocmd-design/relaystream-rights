import fs from "node:fs";
import path from "node:path";

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

import {
  hashMediaContent,
} from "./provenance";

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
   * Unauthorized AI training.
   */

  console.log("\n======================================");
  console.log("TEST 1 - UNAUTHORIZED ACTION");
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
   * Authorized transcoding.
   */

  console.log("\n======================================");
  console.log("TEST 2 - AUTHORIZED ACTION");
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
   * Anchor provenance proof to Solana Devnet.
   */

  const anchor = await anchorProvenanceProof(
    proof.provenanceHash
  );

  console.log("\nPIPELINE: SOLANA ANCHOR CONFIRMED");
  console.log(`SIGNATURE: ${anchor.signature}`);

  /*
   * TEST 3
   * Independently verify the original provenance record.
   */

  console.log("\n======================================");
  console.log("TEST 3 - ORIGINAL PROVENANCE RECORD");
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
   * Tamper with provenance metadata.
   *
   * Only the owner field is changed.
   */

  console.log("\n======================================");
  console.log("TEST 4 - METADATA TAMPER DETECTION");
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
  console.log("METADATA TAMPER TEST RESULT");
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

  console.log("METADATA TAMPER DETECTED: TRUE");

  /*
   * TEST 5
   * Tamper with the actual source media bytes.
   *
   * The original MP4 is NEVER modified.
   * We copy its bytes into memory and change
   * exactly one byte in the in-memory copy.
   */

  console.log("\n======================================");
  console.log("TEST 5 - MEDIA CONTENT TAMPER DETECTION");
  console.log("======================================");

  const sourceMediaPath = path.join(
    process.cwd(),
    "test-media",
    "relaystream-demo.mp4"
  );

  const originalMedia =
    fs.readFileSync(sourceMediaPath);

  /*
   * Create an independent in-memory copy.
   * The file on disk remains untouched.
   */
  const alteredMedia = Buffer.from(originalMedia);

  /*
   * Flip exactly one bit in the final byte.
   */
  alteredMedia[alteredMedia.length - 1] =
    alteredMedia[alteredMedia.length - 1]! ^ 0x01;

  const originalMediaHash =
    hashMediaContent(originalMedia);

  const alteredMediaHash =
    hashMediaContent(alteredMedia);

  console.log(`MEDIA FILE: ${sourceMediaPath}`);
  console.log(`MEDIA SIZE: ${originalMedia.length} bytes`);

  console.log("\nORIGINAL MEDIA SHA-256:");
  console.log(originalMediaHash);

  console.log("\nALTERED MEDIA SHA-256:");
  console.log(alteredMediaHash);

  const mediaHashChanged =
    originalMediaHash !== alteredMediaHash;

  console.log(
    `\nCONTENT HASH CHANGED: ${
      mediaHashChanged ? "TRUE" : "FALSE"
    }`
  );

  if (!mediaHashChanged) {
    throw new Error(
      "Media alteration did not change the content hash."
    );
  }

  /*
   * Substitute the altered media fingerprint into
   * the otherwise identical provenance record.
   *
   * The Solana transaction still contains the proof
   * created for the original media.
   */
  const mediaTamperedRecord = {
    ...proof.record,
    sourceContentHash: alteredMediaHash,
  };

  const mediaTamperedVerification =
    await verifyProvenanceOnChain(
      anchor.signature,
      mediaTamperedRecord
    );

  console.log("\n======================================");
  console.log("MEDIA TAMPER TEST RESULT");
  console.log("======================================");

  console.log(
    `ON-CHAIN VERIFY: ${
      mediaTamperedVerification.verified
        ? "MATCH"
        : "MISMATCH"
    }`
  );

  if (mediaTamperedVerification.verified) {
    throw new Error(
      "Altered media unexpectedly matched the original provenance proof."
    );
  }

  console.log("MEDIA TAMPER DETECTED: TRUE");

  /*
   * Final pipeline summary.
   */

  console.log("\n======================================");
  console.log("END-TO-END RESULT");
  console.log("======================================");

  console.log("RIGHTS CHECK: ALLOW");
  console.log("TRANSFORMATION: AUTHORIZED");
  console.log("REAL MEDIA: SHA-256 BOUND TO PROVENANCE");
  console.log("PROVENANCE: CREATED");
  console.log(
    `PROVENANCE SHA-256: ${proof.provenanceHash}`
  );
  console.log("SOLANA ANCHOR: CONFIRMED");
  console.log(
    `TRANSACTION: ${anchor.signature}`
  );
  console.log("ORIGINAL RECORD VERIFY: MATCH");
  console.log("METADATA TAMPER VERIFY: MISMATCH");
  console.log("METADATA TAMPER DETECTED: TRUE");
  console.log("MEDIA CONTENT VERIFY: MISMATCH");
  console.log("MEDIA TAMPER DETECTED: TRUE");

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