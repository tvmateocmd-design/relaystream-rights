import fs from "node:fs";
import path from "node:path";

import {
  verifyPermission,
  executeAuthorizedTransformation,
} from "./index";

import {
  registerMedia,
  type RightsPolicy,
} from "./register-media";

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
  console.log("REGISTERED MEDIA RIGHTS PIPELINE");
  console.log("======================================");

  /*
   * Define the machine-readable rights policy.
   */
  const policy: RightsPolicy = {
    policyId: "rsp-policy-001",
    commercialUse: "deny",
    aiTraining: "deny",
    derivatives: "allow",
    transcoding: "allow",
    attributionRequired: true,
    provenanceRequired: true,
  };

  /*
   * Register the real source media.
   *
   * Registration reads the actual MP4 bytes,
   * calculates the SHA-256 fingerprint, and
   * attaches the rights policy to the asset.
   */
  const sourceMediaPath = path.join(
    process.cwd(),
    "test-media",
    "relaystream-demo.mp4"
  );

  const registeredAsset = registerMedia({
    assetId: "relaystream-demo-001",
    title: "RelayStream Demo Media",
    owner: "RelayStream",
    sourceUri: "relaystream://media/demo-001",
    sourceFilePath: sourceMediaPath,
    policy,
  });

  /*
   * TEST 1
   * Unauthorized AI training request.
   */

  console.log("\n======================================");
  console.log("TEST 1 - UNAUTHORIZED ACTION");
  console.log("======================================");

  const deniedAction = verifyPermission(
    registeredAsset,
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
   * Authorized transcoding request.
   */

  console.log("\n======================================");
  console.log("TEST 2 - AUTHORIZED ACTION");
  console.log("======================================");

  const allowedAction = verifyPermission(
    registeredAsset,
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
   * Execute the authorized action using the
   * fingerprint established during registration.
   */
  const proof = executeAuthorizedTransformation(
    registeredAsset,
    "transcoding",
    "relaystream-demo-002"
  );

  if (!proof) {
    throw new Error(
      "Authorized transformation did not create provenance."
    );
  }

  console.log("\nPIPELINE: PROVENANCE PROOF READY");
  console.log(
    `SHA-256: ${proof.provenanceHash}`
  );

  /*
   * Anchor the provenance proof to Solana Devnet.
   */
  const anchor = await anchorProvenanceProof(
    proof.provenanceHash
  );

  console.log(
    "\nPIPELINE: SOLANA ANCHOR CONFIRMED"
  );
  console.log(
    `SIGNATURE: ${anchor.signature}`
  );

  /*
   * TEST 3
   * Verify the original registered-media
   * provenance record against Solana.
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

  console.log(
    "\nORIGINAL RECORD: VERIFIED"
  );

  /*
   * TEST 4
   * Modify provenance metadata.
   */

  console.log("\n======================================");
  console.log("TEST 4 - METADATA TAMPER DETECTION");
  console.log("======================================");

  const tamperedRecord = {
    ...proof.record,
    owner: "Tampered Owner",
  };

  console.log(
    `ORIGINAL OWNER: ${proof.record.owner}`
  );
  console.log(
    `TAMPERED OWNER: ${tamperedRecord.owner}`
  );

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

  console.log(
    "METADATA TAMPER DETECTED: TRUE"
  );

  /*
   * TEST 5
   * Modify exactly one bit of the registered
   * source media in memory.
   *
   * The original MP4 on disk is untouched.
   */

  console.log("\n======================================");
  console.log("TEST 5 - MEDIA CONTENT TAMPER DETECTION");
  console.log("======================================");

  const originalMedia =
    fs.readFileSync(
      registeredAsset.sourceFilePath
    );

  const alteredMedia =
    Buffer.from(originalMedia);

  alteredMedia[alteredMedia.length - 1] =
    alteredMedia[alteredMedia.length - 1]! ^ 0x01;

  const originalMediaHash =
    hashMediaContent(originalMedia);

  const alteredMediaHash =
    hashMediaContent(alteredMedia);

  console.log(
    `MEDIA FILE: ${registeredAsset.sourceFilePath}`
  );
  console.log(
    `MEDIA SIZE: ${originalMedia.length} bytes`
  );

  console.log("\nREGISTERED MEDIA SHA-256:");
  console.log(
    registeredAsset.sourceContentHash
  );

  console.log("\nRECOMPUTED ORIGINAL SHA-256:");
  console.log(originalMediaHash);

  console.log("\nALTERED MEDIA SHA-256:");
  console.log(alteredMediaHash);

  /*
   * First prove that the file currently on disk
   * still matches the fingerprint established
   * during registration.
   */
  const registeredMediaMatches =
    registeredAsset.sourceContentHash ===
    originalMediaHash;

  console.log(
    `\nREGISTERED MEDIA MATCH: ${
      registeredMediaMatches
        ? "TRUE"
        : "FALSE"
    }`
  );

  if (!registeredMediaMatches) {
    throw new Error(
      "Source media no longer matches its registered fingerprint."
    );
  }

  const mediaHashChanged =
    originalMediaHash !== alteredMediaHash;

  console.log(
    `CONTENT HASH CHANGED: ${
      mediaHashChanged
        ? "TRUE"
        : "FALSE"
    }`
  );

  if (!mediaHashChanged) {
    throw new Error(
      "Media alteration did not change the content hash."
    );
  }

  /*
   * Substitute the altered content fingerprint
   * into the otherwise identical provenance record.
   *
   * The Solana anchor contains the proof created
   * for the registered original media.
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

  console.log(
    "MEDIA TAMPER DETECTED: TRUE"
  );

  /*
   * Final Day 5 pipeline summary.
   */

  console.log("\n======================================");
  console.log("END-TO-END RESULT");
  console.log("======================================");

  console.log("MEDIA REGISTRATION: COMPLETE");
  console.log("RIGHTS POLICY: ATTACHED");
  console.log(
    "AI TRAINING REQUEST: DENY / BLOCKED"
  );
  console.log(
    "TRANSCODING REQUEST: ALLOW / AUTHORIZED"
  );
  console.log(
    "REGISTERED MEDIA SHA-256: BOUND TO PROVENANCE"
  );
  console.log("PROVENANCE: CREATED");
  console.log(
    `PROVENANCE SHA-256: ${proof.provenanceHash}`
  );
  console.log("SOLANA ANCHOR: CONFIRMED");
  console.log(
    `TRANSACTION: ${anchor.signature}`
  );
  console.log(
    "ORIGINAL RECORD VERIFY: MATCH"
  );
  console.log(
    "METADATA TAMPER VERIFY: MISMATCH"
  );
  console.log(
    "MEDIA CONTENT VERIFY: MISMATCH"
  );
  console.log(
    "MEDIA TAMPER DETECTED: TRUE"
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