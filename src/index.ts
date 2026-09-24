import {
  createProvenanceRecord,
  createProvenanceProof,
  type ProvenanceAction,
} from "./provenance";

import {
  hashRightsPolicy,
  type RegisteredMediaAsset,
  type RightsAction,
} from "./register-media";

interface VerificationResult {
  assetId: string;
  policyId: string;
  owner: string;
  action: RightsAction;
  decision: "allow" | "deny";
  authorized: boolean;
  policyIntegrityValid: boolean;
  registeredPolicyHash: string;
  currentPolicyHash: string;
  attributionRequired: boolean;
  provenanceRequired: boolean;
  reason: string;
}

export function verifyPermission(
  asset: RegisteredMediaAsset,
  action: RightsAction
): VerificationResult {
  /*
   * Recompute the SHA-256 hash of the policy
   * currently attached to the registered asset.
   *
   * The result must match the policy hash that
   * was established when the media was registered.
   *
   * If the hashes differ, the policy has changed
   * and authorization fails closed.
   */
  const currentPolicyHash =
    hashRightsPolicy(asset.policy);

  const policyIntegrityValid =
    currentPolicyHash === asset.policyHash;

  const actionLabels: Record<RightsAction, string> = {
    commercialUse: "Commercial use",
    aiTraining: "AI training",
    derivatives: "Derivative creation",
    transcoding: "Transcoding",
  };

  if (!policyIntegrityValid) {
    return {
      assetId: asset.assetId,
      policyId: asset.policy.policyId,
      owner: asset.owner,
      action,
      decision: "deny",
      authorized: false,
      policyIntegrityValid: false,
      registeredPolicyHash: asset.policyHash,
      currentPolicyHash,
      attributionRequired:
        asset.policy.attributionRequired,
      provenanceRequired:
        asset.policy.provenanceRequired,
      reason:
        `Policy integrity verification failed for ${asset.policy.policyId}. The current policy hash does not match the policy hash established at registration.`,
    };
  }

  const decision = asset.policy[action];

  const authorized = decision === "allow";

  return {
    assetId: asset.assetId,
    policyId: asset.policy.policyId,
    owner: asset.owner,
    action,
    decision,
    authorized,
    policyIntegrityValid: true,
    registeredPolicyHash: asset.policyHash,
    currentPolicyHash,
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

  console.log("\nPOLICY INTEGRITY");
  console.log("==============================");
  console.log(
    `REGISTERED POLICY SHA-256: ${verification.registeredPolicyHash}`
  );
  console.log(
    `CURRENT POLICY SHA-256:    ${verification.currentPolicyHash}`
  );
  console.log(
    `INTEGRITY: ${
      verification.policyIntegrityValid
        ? "VERIFIED"
        : "FAILED"
    }`
  );

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
   * and verified policy hash into the
   * provenance record.
   */
  const provenance =
    createProvenanceRecord(
      asset.assetId,
      derivedAssetId,
      asset.policy.policyId,
      asset.policyHash,
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