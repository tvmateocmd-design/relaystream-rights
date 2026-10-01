import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProvenanceAction } from "./provenance";
import {
  transcodeMedia,
  TranscodeError,
  type TranscodeOptions,
  type TranscodeResult,
} from "./transcode-media";

import {
  hashRightsPolicy,
  type RegisteredMediaAsset,
  type RightsAction,
} from "./register-media";

export interface VerificationResult {
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

export interface ExecutionOptions {
  outputDirectory?: string;
  processorOptions?: TranscodeOptions;
}

export interface ExecutionDependencies {
  processor: typeof transcodeMedia;
}

interface ExecutionContext {
  assetId: string;
  derivedAssetId: string;
  action: ProvenanceAction;
  authorization: VerificationResult;
  // This checkpoint stops before any proof, blockchain or economic operation.
  provenanceCreated: false;
  solanaAnchored: false;
  royaltyEventCreated: false;
}

export type ExecutionResult = ExecutionContext & (
  | {
      status: "blocked";
      reasonCode: "PERMISSION_DENIED" | "POLICY_INTEGRITY_FAILED";
      reason: string;
      processorInvoked: false;
      processingCompleted: false;
      executionId: null;
      processingResult: null;
    }
  | {
      status: "failed";
      stage: "request_validation" | "source_validation" | "processing";
      error: { code: string; message: string };
      processorInvoked: boolean;
      processingCompleted: false;
      executionId: null;
      processingResult: null;
    }
  | {
      status: "processed";
      processorInvoked: true;
      processingCompleted: true;
      executionId: string;
      processingResult: TranscodeResult;
    }
);

export async function executeAuthorizedTransformation(
  asset: RegisteredMediaAsset,
  action: ProvenanceAction,
  derivedAssetId: string,
  options: ExecutionOptions = {},
  dependencies: ExecutionDependencies = { processor: transcodeMedia },
): Promise<ExecutionResult> {
  // Copy both the asset and nested policy before checking permission or awaiting IO.
  const snapshot = structuredClone(asset);
  Object.freeze(snapshot.policy);
  Object.freeze(snapshot);
  const authorization = Object.freeze(verifyPermission(snapshot, action));
  const context: ExecutionContext = {
    assetId: snapshot.assetId,
    derivedAssetId,
    action,
    authorization,
    provenanceCreated: false,
    solanaAnchored: false,
    royaltyEventCreated: false,
  };
  if (!authorization.authorized || !authorization.policyIntegrityValid) {
    return {
      ...context,
      status: "blocked",
      reasonCode: authorization.policyIntegrityValid ? "PERMISSION_DENIED" : "POLICY_INTEGRITY_FAILED",
      reason: authorization.reason,
      processorInvoked: false,
      processingCompleted: false,
      executionId: null,
      processingResult: null,
    };
  }

  const fail = (
    stage: "request_validation" | "source_validation" | "processing",
    code: string,
    message: string,
    processorInvoked = false,
  ): ExecutionResult => ({
    ...context, status: "failed", stage, error: { code, message },
    processorInvoked, processingCompleted: false, executionId: null, processingResult: null,
  });
  if (action !== "transcoding") {
    return fail("request_validation", "UNSUPPORTED_ACTION", "Only transcoding has a real media processor.");
  }
  if (!derivedAssetId.trim()) {
    return fail("request_validation", "INVALID_DERIVED_ASSET_ID", "A derived asset ID is required.");
  }
  // Capture configuration as well, so callers cannot change it across the await.
  const outputDirectory = path.resolve(options.outputDirectory ?? "generated-media");
  const processorOptions = { ...options.processorOptions };
  const processor = dependencies.processor;
  try {
    const sourceBytes = await readFile(snapshot.sourceFilePath);
    const currentSourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    if (currentSourceHash !== snapshot.sourceContentHash) {
      return fail("source_validation", "SOURCE_HASH_MISMATCH", "Source bytes do not match the SHA-256 established at registration.");
    }
  } catch (error) {
    return fail("source_validation", "SOURCE_READ_FAILED", error instanceof Error ? error.message : "Cannot read registered source media.");
  }

  try {
    // The adapter independently verifies the exact snapshot it feeds to FFmpeg.
    const processingResult = await processor({
      sourceFilePath: snapshot.sourceFilePath,
      expectedSourceContentHash: snapshot.sourceContentHash,
      outputDirectory,
    }, processorOptions);
    return {
      ...context, status: "processed", processorInvoked: true, processingCompleted: true,
      executionId: processingResult.executionId, processingResult,
    };
  } catch (error) {
    return fail(
      "processing", error instanceof TranscodeError ? error.code : "PROCESSING_FAILED",
      error instanceof Error ? error.message : "Media processing failed.", true,
    );
  }
}
