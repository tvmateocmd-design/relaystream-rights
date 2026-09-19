import {
  createProvenanceRecord,
  createProvenanceProof,
  type ProvenanceAction,
} from "./provenance";

import type {
  RegisteredMediaAsset,
  RightsAction,
} from "./register-media";

interface VerificationResult {
  assetId: string;
  policyId: string;
  owner: string;
  action: RightsAction;
  decision: "allow" | "deny";
  authorized: boolean;
  attributionRequired: boolean;
  provenanceRequired: boolean;
  reason: string;
}

export function verifyPermission(
  asset: RegisteredMediaAsset,
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
    attributionRequired:
      asset.policy.attributionRequired,
    provenanceRequired:
      asset.policy.provenanceRequired,

    reason: authorized
      ? `${actionLabels[action]} is authorized under policy ${asset.policy.policyId}.`
      : `${actionLabels[action]} is prohibited under policy ${asset.policy.policyId}.`,
  };
}

export function executeAuthorizedTransformation(
  asset: RegisteredMediaAsset,
  action: ProvenanceAction,
  derivedAssetId: string
) {
  const verification =
    verifyPermission(asset, action);

  console.log("\n==============================");
  console.log("TRANSFORMATION REQUEST");
  console.log("==============================");
  console.log(`Source Asset: ${asset.assetId}`);
  console.log(`Requested Action: ${action}`);

  if (!verification.authorized) {
    console.log("STATUS: BLOCKED");
    console.log(
      `REASON: ${verification.reason}`
    );
    return null;
  }

  console.log("STATUS: AUTHORIZED");
  console.log(
    `Derived Asset: ${derivedAssetId}`
  );

  /*
   * The media fingerprint was established
   * during registration.
   *
   * The transformation engine does not
   * independently invent or rediscover
   * the identity of the source media.
   */
  console.log("\nREGISTERED MEDIA FINGERPRINT");
  console.log("==============================");
  console.log(
    `HASH ALGORITHM: ${asset.hashAlgorithm}`
  );
  console.log(
    `CONTENT SHA-256: ${asset.sourceContentHash}`
  );

  /*
   * Bind the registered media fingerprint
   * into the provenance record.
   */
  const provenance =
    createProvenanceRecord(
      asset.assetId,
      derivedAssetId,
      asset.policy.policyId,
      action,
      asset.owner,
      asset.sourceContentHash
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