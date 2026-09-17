import fs from "node:fs";
import path from "node:path";

import {
  createProvenanceRecord,
  createProvenanceProof,
  hashMediaContent,
  type ProvenanceAction,
} from "./provenance";

type Permission = "allow" | "deny";

type RightsAction =
  | "commercialUse"
  | "aiTraining"
  | "derivatives"
  | "transcoding";

interface RightsPolicy {
  policyId: string;
  commercialUse: Permission;
  aiTraining: Permission;
  derivatives: Permission;
  transcoding: Permission;
  attributionRequired: boolean;
  provenanceRequired: boolean;
}

interface MediaAsset {
  assetId: string;
  title: string;
  owner: string;
  sourceUri: string;
  policy: RightsPolicy;
}

interface VerificationResult {
  assetId: string;
  policyId: string;
  owner: string;
  action: RightsAction;
  decision: Permission;
  authorized: boolean;
  attributionRequired: boolean;
  provenanceRequired: boolean;
  reason: string;
}

export const demoAsset: MediaAsset = {
  assetId: "relaystream-demo-001",
  title: "RelayStream Demo Media",
  owner: "RelayStream",
  sourceUri: "relaystream://media/demo-001",

  policy: {
    policyId: "rsp-policy-001",
    commercialUse: "deny",
    aiTraining: "deny",
    derivatives: "allow",
    transcoding: "allow",
    attributionRequired: true,
    provenanceRequired: true,
  },
};

export function verifyPermission(
  asset: MediaAsset,
  action: RightsAction
): VerificationResult {
  const decision = asset.policy[action];

  const actionLabels: Record<RightsAction, string> = {
    commercialUse: "Commercial use",
    aiTraining: "AI training",
    derivatives: "Derivative creation",
    transcoding: "Transcoding",
  };

  const authorized = decision === "allow";

  return {
    assetId: asset.assetId,
    policyId: asset.policy.policyId,
    owner: asset.owner,
    action,
    decision,
    authorized,
    attributionRequired: asset.policy.attributionRequired,
    provenanceRequired: asset.policy.provenanceRequired,

    reason: authorized
      ? `${actionLabels[action]} is authorized under policy ${asset.policy.policyId}.`
      : `${actionLabels[action]} is prohibited under policy ${asset.policy.policyId}.`,
  };
}

export function executeAuthorizedTransformation(
  asset: MediaAsset,
  action: ProvenanceAction,
  derivedAssetId: string
) {
  const verification = verifyPermission(asset, action);

  console.log("\n==============================");
  console.log("TRANSFORMATION REQUEST");
  console.log("==============================");
  console.log(`Source Asset: ${asset.assetId}`);
  console.log(`Requested Action: ${action}`);

  if (!verification.authorized) {
    console.log("STATUS: BLOCKED");
    console.log(`REASON: ${verification.reason}`);
    return null;
  }

  /*
   * Read the actual source media file from disk.
   *
   * The SHA-256 fingerprint is calculated from
   * the real binary bytes of the MP4.
   */
  const sourceMediaPath = path.join(
    process.cwd(),
    "test-media",
    "relaystream-demo.mp4"
  );

  const sourceMediaContent =
    fs.readFileSync(sourceMediaPath);

  const sourceContentHash =
    hashMediaContent(sourceMediaContent);

  console.log("STATUS: AUTHORIZED");
  console.log(`Derived Asset: ${derivedAssetId}`);

  console.log("\nSOURCE MEDIA FILE");
  console.log("==============================");
  console.log(`FILE: ${sourceMediaPath}`);
  console.log(
    `SIZE: ${sourceMediaContent.length} bytes`
  );

  console.log("\nSOURCE MEDIA FINGERPRINT");
  console.log("==============================");
  console.log("HASH ALGORITHM: sha256");
  console.log(
    `CONTENT SHA-256: ${sourceContentHash}`
  );

  /*
   * Bind the source media fingerprint
   * into the provenance record.
   */
  const provenance = createProvenanceRecord(
    asset.assetId,
    derivedAssetId,
    asset.policy.policyId,
    action,
    asset.owner,
    sourceContentHash
  );

  console.log("\nPROVENANCE CREATED:");
  console.log(provenance);

  const proof =
    createProvenanceProof(provenance);

  console.log("\nPROVENANCE PROOF");
  console.log("==============================");
  console.log(
    `HASH ALGORITHM: ${proof.hashAlgorithm}`
  );
  console.log(
    `SHA-256: ${proof.provenanceHash}`
  );

  return proof;
}