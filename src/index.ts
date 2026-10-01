import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createProvenanceV2Proof,
  verifyProvenanceProof,
  ProvenanceError,
  type CompletedMediaProcessing,
  type ProvenanceAction,
  type ProvenanceProof,
  type ProvenanceV2Record,
} from "./provenance";
import {
  transcodeMedia,
  TranscodeError,
  type TranscodeOptions,
  type TranscodeResult,
} from "./transcode-media";
import { anchorProvenanceProof, AnchorError, getDevnetAuthority, provenanceMemo, DEVNET_ENDPOINT, DEVNET_GENESIS_HASH, type AnchorResult } from "./anchor-provenance";
import { verifyProvenanceOnChain, type VerificationResult as OnChainVerification } from "./verify-provenance";
import { createDemoRoyaltyRule, prepareRoyaltyRequest, createRoyaltyEvent, RoyaltyError, type PreparedRoyaltyRequest, type RoyaltyReceipt } from "./royalties";
import { FileRoyaltyEventStore, type RoyaltyEventStore } from "./royalty-event-store";

import {
  hashRightsPolicy,
  type RegisteredMediaAsset,
  type RightsAction,
} from "./register-media";

export interface VerificationResult {
  assetId: string;
  policyId: string;
  owner: string;
  sourceContentHash: string;
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
      sourceContentHash: asset.sourceContentHash,
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
    sourceContentHash: asset.sourceContentHash,
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
  usageAmount?: number | string;
  royaltyLedgerDirectory?: string;
}

export interface ExecutionDependencies {
  processor: typeof transcodeMedia;
  createProof?: typeof createProvenanceV2Proof;
  anchor?: typeof anchorProvenanceProof;
  getAuthority?: typeof getDevnetAuthority;
  verifyAnchor?: typeof verifyProvenanceOnChain;
  createRoyalty?: typeof createRoyaltyEvent;
  royaltyStore?: RoyaltyEventStore;
}

export interface AnchorReceipt {
  state: "verified" | "failed";
  stage: "preflight" | "submission" | "confirmation" | "verification";
  transactionStatus: "not_submitted" | "unknown" | "failed" | "confirmed";
  signature: string | null;
  expectedAuthority: string | null;
  submission: AnchorResult | null;
  verification: OnChainVerification | null;
  error: string | null;
}

interface ExecutionContext {
  assetId: string;
  derivedAssetId: string;
  action: ProvenanceAction;
  authorization: VerificationResult;
  solanaAnchored: boolean;
  solanaSignature: string | null;
  anchor: AnchorReceipt | null;
  royaltyEventCreated: boolean;
  royaltyAllocated: boolean;
  royalty: RoyaltyReceipt | null;
  fundsTransferred: false;
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
      provenanceCreated: false;
      provenance: null;
      proof: null;
    }
  | {
      status: "failed";
      stage: "request_validation" | "source_validation" | "processing" | "provenance";
      error: { code: string; message: string };
      processorInvoked: boolean;
      processingCompleted: boolean;
      executionId: string | null;
      processingResult: TranscodeResult | null;
      provenanceCreated: false;
      provenance: null;
      proof: null;
    }
  | {
      status: "failed";
      stage: "anchor";
      error: { code: string; message: string };
      processorInvoked: true;
      processingCompleted: true;
      executionId: string;
      processingResult: TranscodeResult;
      provenanceCreated: true;
      provenance: ProvenanceV2Record;
      proof: ProvenanceProof<ProvenanceV2Record>;
      solanaAnchored: false;
      anchor: AnchorReceipt;
    }
  | {
      status: "failed";
      stage: "royalty";
      error: { code: string; message: string };
      processorInvoked: true;
      processingCompleted: true;
      executionId: string;
      processingResult: TranscodeResult;
      provenanceCreated: true;
      provenance: ProvenanceV2Record;
      proof: ProvenanceProof<ProvenanceV2Record>;
      solanaAnchored: true;
      solanaSignature: string;
      anchor: AnchorReceipt;
      royaltyEventCreated: false;
      royaltyAllocated: false;
      royalty: null;
    }
  | {
      status: "processed";
      processorInvoked: true;
      processingCompleted: true;
      executionId: string;
      processingResult: TranscodeResult;
      provenanceCreated: true;
      provenance: ProvenanceV2Record;
      proof: ProvenanceProof<ProvenanceV2Record>;
      solanaAnchored: true;
      solanaSignature: string;
      anchor: AnchorReceipt;
      royaltyEventCreated: true;
      royaltyAllocated: true;
      royalty: RoyaltyReceipt;
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
    solanaAnchored: false,
    solanaSignature: null,
    anchor: null,
    royaltyEventCreated: false,
    royaltyAllocated: false,
    royalty: null,
    fundsTransferred: false,
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
      provenanceCreated: false,
      provenance: null,
      proof: null,
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
    provenanceCreated: false, provenance: null, proof: null,
  });
  if (action !== "transcoding") {
    return fail("request_validation", "UNSUPPORTED_ACTION", "Only transcoding has a real media processor.");
  }
  if (!derivedAssetId.trim()) {
    return fail("request_validation", "INVALID_DERIVED_ASSET_ID", "A derived asset ID is required.");
  }
  let royaltyRequest: PreparedRoyaltyRequest;
  try {
    royaltyRequest = prepareRoyaltyRequest(snapshot.royaltyRule ?? createDemoRoyaltyRule(snapshot.assetId), snapshot.assetId,
      options.usageAmount === undefined ? 100 : options.usageAmount);
  } catch (error) {
    return fail("request_validation", "INVALID_ROYALTY_REQUEST", error instanceof Error ? error.message : "Invalid royalty rule or usage amount.");
  }
  // Capture configuration as well, so callers cannot change it across the await.
  const outputDirectory = path.resolve(options.outputDirectory ?? "generated-media");
  const processorOptions = { ...options.processorOptions };
  const processor = dependencies.processor;
  const createProof = dependencies.createProof ?? createProvenanceV2Proof;
  const anchorProof = dependencies.anchor ?? anchorProvenanceProof;
  const getAuthority = dependencies.getAuthority ?? getDevnetAuthority;
  const verifyAnchor = dependencies.verifyAnchor ?? verifyProvenanceOnChain;
  const createRoyalty = dependencies.createRoyalty ?? createRoyaltyEvent;
  const royaltyStore = dependencies.royaltyStore ?? new FileRoyaltyEventStore(options.royaltyLedgerDirectory ?? "royalty-ledger");
  let proof: ProvenanceProof<ProvenanceV2Record>;
  try {
    const sourceBytes = await readFile(snapshot.sourceFilePath);
    const currentSourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    if (currentSourceHash !== snapshot.sourceContentHash) {
      return fail("source_validation", "SOURCE_HASH_MISMATCH", "Source bytes do not match the SHA-256 established at registration.");
    }
  } catch (error) {
    return fail("source_validation", "SOURCE_READ_FAILED", error instanceof Error ? error.message : "Cannot read registered source media.");
  }

  let processingResult: TranscodeResult;
  try {
    // The adapter independently verifies the exact snapshot it feeds to FFmpeg.
    processingResult = await processor({
      sourceFilePath: snapshot.sourceFilePath,
      expectedSourceContentHash: snapshot.sourceContentHash,
      outputDirectory,
    }, processorOptions);
  } catch (error) {
    return fail(
      "processing", error instanceof TranscodeError ? error.code : "PROCESSING_FAILED",
      error instanceof Error ? error.message : "Media processing failed.", true,
    );
  }

  try {
    const completed: CompletedMediaProcessing = {
      ...context, status: "processed", processorInvoked: true, processingCompleted: true,
      executionId: processingResult.executionId, processingResult,
    };
    // Uses only the execution-owned authorization and completed processing result.
    // The factory independently validates output bytes before constructing a record.
    proof = await createProof(completed);
    // The anchor boundary independently checks the completed proof before ANY Solana dependency.
    if (proof.record.schemaVersion !== 2 || !verifyProvenanceProof(proof)) {
      throw new ProvenanceError("PROOF_VERIFICATION_FAILED", "Completed Provenance v2 proof failed local hash verification.");
    }
  } catch (error) {
    return {
      ...context, status: "failed", stage: "provenance",
      error: {
        code: error instanceof ProvenanceError ? error.code : "PROVENANCE_FAILED",
        message: error instanceof Error ? error.message : "Cannot create verified provenance.",
      },
      processorInvoked: true, processingCompleted: true,
      executionId: processingResult?.executionId ?? null, processingResult,
      provenanceCreated: false, provenance: null, proof: null,
    };
  }

  const localResult = {
    ...context, processorInvoked: true as const, processingCompleted: true as const,
    executionId: processingResult.executionId, processingResult,
    provenanceCreated: true as const, provenance: proof.record, proof,
  };
  let expectedAuthority: string | null = null;
  let submission: AnchorResult | null = null;
  let verification: OnChainVerification | null = null;
  let anchorStage: AnchorReceipt["stage"] = "preflight";
  let verifiedReceipt: AnchorReceipt;
  let verifiedSignature: string;
  try {
    expectedAuthority = getAuthority();
    anchorStage = "submission";
    submission = await anchorProof(proof.provenanceHash, expectedAuthority, 2);
    anchorStage = "verification";
    const expectedMemo = provenanceMemo(proof.provenanceHash, 2);
    if (!submission.confirmed || submission.network !== "devnet" || submission.signer !== expectedAuthority
      || submission.provenanceHash !== proof.provenanceHash || submission.memo !== expectedMemo || !submission.signature) {
      throw new Error("Anchor response does not describe the expected confirmed Devnet commitment.");
    }
    // A fresh connection fetches the exact signature; submission logs are never evidence.
    verification = await verifyAnchor(submission.signature, proof.record, expectedAuthority);
    if (!verification.verified || !verification.transactionSucceeded || verification.signature !== submission.signature
      || verification.computedHash !== proof.provenanceHash || verification.expectedMemo !== expectedMemo
      || verification.onChainMemo !== expectedMemo || verification.expectedAuthority !== expectedAuthority
      || verification.verifiedAuthority !== expectedAuthority || verification.network !== "devnet"
      || verification.rpcEndpoint !== DEVNET_ENDPOINT || verification.genesisHash !== DEVNET_GENESIS_HASH) {
      throw new Error(verification.reason || "Independent Devnet verification failed.");
    }
    verifiedSignature = submission.signature;
    verifiedReceipt = { state: "verified", stage: "verification", transactionStatus: "confirmed", signature: submission.signature,
      expectedAuthority, submission, verification, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Solana anchoring failed.";
    const signature = error instanceof AnchorError ? error.signature : submission?.signature ?? null;
    return {
      ...localResult, status: "failed", stage: "anchor", error: { code: "ANCHOR_FAILED", message },
      solanaAnchored: false, solanaSignature: signature,
      anchor: { state: "failed", stage: error instanceof AnchorError ? error.stage : anchorStage,
        transactionStatus: error instanceof AnchorError ? error.transactionStatus : submission?.confirmed ? "confirmed"
          : anchorStage === "preflight" ? "not_submitted" : "unknown",
        signature, expectedAuthority, submission, verification, error: message },
    };
  }
  const anchored = { ...localResult, solanaAnchored: true as const, solanaSignature: verifiedSignature, anchor: verifiedReceipt };
  try {
    // The royalty factory rechecks the exact verified proof/anchor binding and commits
    // event plus allocation atomically under the execution's idempotency key.
    const royalty = await createRoyalty(anchored, royaltyRequest, royaltyStore);
    return { ...anchored, status: "processed", royaltyEventCreated: true, royaltyAllocated: true, royalty };
  } catch (error) {
    return { ...anchored, status: "failed", stage: "royalty", royaltyEventCreated: false, royaltyAllocated: false, royalty: null,
      error: { code: error instanceof RoyaltyError ? error.code : "ROYALTY_FAILED",
        message: error instanceof Error ? error.message : "Cannot record royalty allocation." } };
  }
}
