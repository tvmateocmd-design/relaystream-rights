import { executeAuthorizedTransformation, type ExecutionDependencies, type ExecutionOptions, type ExecutionResult } from "./index";
import { transcodeMedia } from "./transcode-media";
import { anchorProvenanceProof, getDevnetAuthority } from "./anchor-provenance";
import { verifyProvenanceOnChain } from "./verify-provenance";
import { createProvenanceV2Proof } from "./provenance";
import { createRoyaltyEvent } from "./royalties";
import type { RegisteredMediaAsset, RightsAction } from "./register-media";
import type { ExecutionObservation } from "./execution-observer";

export interface DemoRequest {
  requestId: string;
  assetId: string;
  action: RightsAction;
  derivedAssetId: string;
  usageAmount?: string | number;
}
export const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PUBLIC_ID = /^[A-Za-z0-9_-]{1,80}$/;
export class DemoRequestError extends Error {
  constructor(readonly statusCode: number, readonly code: string) { super(code); }
}
interface Calls { processor: number; provenance: number; anchor: number; verifyAnchor: number; royalty: number; }
interface Run {
  request: DemoRequest;
  fingerprint: string;
  state: "running" | "complete" | "unknown";
  acceptedAt: string;
  completedAt: string | null;
  milestones: (ExecutionObservation & { sequence: number })[];
  calls: Calls;
  result: ExecutionResult | null;
  finished: Promise<void> | null;
}

function select(value: object, fields: readonly string[]): Record<string, unknown> {
  const source = value as Record<string, unknown>;
  return Object.fromEntries(fields.map(field => [field, source[field]]));
}
function publicProcessing(value: NonNullable<ExecutionResult["processingResult"]>["processing"]) {
  return { ...select(value, ["tool", "toolVersion", "probeVersion", "startedAt", "completedAt", "outputFormat", "videoCodec",
    "audioCodec", "pixelFormat", "width", "height", "durationMs"]),
    profile: select(value.profile, ["profileId", "format", "videoEncoder", "width", "crf", "preset", "pixelFormat", "audioEncoder", "audioBitrate", "faststart"]) };
}

/** Explicit public projection: never serialize internal paths or exception diagnostics. */
export function publicExecution(result: ExecutionResult) {
  const record = result.provenance && { ...select(result.provenance, ["schemaVersion", "provenanceId", "executionId", "sourceAssetId",
    "derivedAssetId", "policyId", "policyHash", "action", "owner", "sourceContentHash", "outputContentHash", "outputSizeBytes", "createdAt"]),
    processing: publicProcessing(result.provenance.processing) };
  const a = result.authorization;
  return {
    status: result.status,
    ...select(result, ["status", "assetId", "derivedAssetId", "action", "processorInvoked", "processingCompleted", "executionId",
      "provenanceCreated", "solanaAnchored", "solanaSignature", "royaltyEventCreated", "royaltyAllocated", "fundsTransferred"]),
    authorization: { ...select(a, ["assetId", "policyId", "owner", "sourceContentHash", "action", "decision", "authorized",
      "policyIntegrityValid", "registeredPolicyHash", "currentPolicyHash", "attributionRequired", "provenanceRequired"]),
      reason: a.policyIntegrityValid ? a.authorized ? "Action authorized by registered policy." : "Action prohibited by registered policy."
        : "Registered policy integrity check failed." },
    ...(result.status === "blocked" ? { reasonCode: result.reasonCode, reason: "Action blocked by the authorization gate." } : {}),
    ...(result.status === "failed" ? { stage: result.stage, error: { code: result.error.code, message: "Execution failed at the reported stage." } } : {}),
    processingResult: result.processingResult ? { ...select(result.processingResult, ["executionId", "sourceContentHash", "outputContentHash", "outputSizeBytes", "hashAlgorithm"]),
      processing: publicProcessing(result.processingResult.processing) } : null,
    provenance: record,
    proof: result.proof ? { hashAlgorithm: result.proof.hashAlgorithm, provenanceHash: result.proof.provenanceHash, record } : null,
    anchor: result.anchor ? { ...select(result.anchor, ["state", "stage", "transactionStatus", "signature", "expectedAuthority"]),
      submission: result.anchor.submission ? select(result.anchor.submission, ["signature", "provenanceHash", "memo", "signer", "network", "confirmed"]) : null,
      verification: result.anchor.verification ? { ...select(result.anchor.verification, ["verified", "signature", "computedHash", "expectedMemo", "onChainMemo",
        "expectedAuthority", "verifiedAuthority", "network", "rpcEndpoint", "genesisHash", "transactionSucceeded", "slot"]),
        reason: result.anchor.verification.verified ? "Exact Devnet commitment and authority verified." : "Independent chain verification failed." } : null,
      error: result.anchor.error ? "Anchor did not independently verify." : null } : null,
    royalty: result.royalty ? { created: result.royalty.created, proof: select(result.royalty.proof, ["hashAlgorithm", "royaltyEventHash"]),
      event: { ...select(result.royalty.event, ["schemaVersion", "royaltyEventId", "executionId", "royaltyRuleId", "assetId", "derivedAssetId", "action",
        "authorized", "currency", "minorUnitScale", "usageAmountMinorUnits", "usageAmount", "provenanceId", "provenanceHash", "solanaSignature",
        "verifiedAuthority", "totalAllocatedMinorUnits", "totalAllocated", "remainderMethod", "allocationOnly", "fundsTransferred", "createdAt"]),
        allocations: result.royalty.event.allocations.map(allocation => select(allocation, ["role", "wallet", "percentage", "basisPoints", "amountMinorUnits", "amount"])) } } : null,
  };
}

/** Session-scoped. IDs are never evicted/reused: capacity fails closed rather than replaying an old request. */
export class DemoExecutions {
  private readonly runs = new Map<string, Run>();
  private active: string | null = null;
  constructor(private readonly outputRoot: string, private readonly dependencies: ExecutionDependencies = { processor: transcodeMedia },
    private readonly capacity = 100, private readonly executionOptions: ExecutionOptions = {}) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Invalid registry capacity.");
  }

  start(request: DemoRequest, asset: RegisteredMediaAsset) {
    if (!REQUEST_ID.test(request.requestId) || !PUBLIC_ID.test(request.assetId) || !PUBLIC_ID.test(request.derivedAssetId)
      || request.assetId !== asset.assetId) throw new DemoRequestError(400, "INVALID_REQUEST");
    const captured = structuredClone(request);
    captured.requestId = captured.requestId.toLowerCase();
    const fingerprint = JSON.stringify([captured.assetId, captured.action, captured.derivedAssetId,
      captured.usageAmount === undefined ? ["default"] : [typeof captured.usageAmount, captured.usageAmount]]);
    const existing = this.runs.get(captured.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new DemoRequestError(409, "REQUEST_ID_CONFLICT");
      return this.get(captured.requestId)!;
    }
    if (this.active) throw new DemoRequestError(409, "EXECUTION_ACTIVE");
    if (this.runs.size >= this.capacity) throw new DemoRequestError(429, "REGISTRY_FULL");
    const run: Run = { request: captured, fingerprint, state: "running", acceptedAt: new Date().toISOString(), completedAt: null,
      milestones: [], calls: { processor: 0, provenance: 0, anchor: 0, verifyAnchor: 0, royalty: 0 }, result: null, finished: null };
    this.runs.set(captured.requestId, run);
    this.active = captured.requestId;
    const d = { ...this.dependencies };
    const observed: ExecutionDependencies = { ...d,
      processor: (...args) => { run.calls.processor++; return d.processor(...args); },
      createProof: (...args) => { run.calls.provenance++; return (d.createProof ?? createProvenanceV2Proof)(...args); },
      getAuthority: d.getAuthority ?? getDevnetAuthority,
      anchor: (...args) => { run.calls.anchor++; return (d.anchor ?? anchorProvenanceProof)(...args); },
      verifyAnchor: (...args) => { run.calls.verifyAnchor++; return (d.verifyAnchor ?? verifyProvenanceOnChain)(...args); },
      createRoyalty: (...args) => { run.calls.royalty++; return (d.createRoyalty ?? createRoyaltyEvent)(...args); },
    };
    const pending = executeAuthorizedTransformation(asset, captured.action, captured.derivedAssetId, {
      ...this.executionOptions, outputDirectory: this.outputRoot,
      ...(captured.usageAmount === undefined ? {} : { usageAmount: captured.usageAmount }),
      observer: event => { run.milestones.push({ ...event, sequence: run.milestones.length + 1 }); },
    }, observed);
    run.finished = pending.then(result => { run.result = structuredClone(result); run.state = "complete"; }, () => {
      // Unexpected protocol rejection is uncertain, never an invitation to replay.
      run.state = "unknown";
    }).finally(() => { run.completedAt = new Date().toISOString(); this.active = null; });
    return this.get(captured.requestId)!;
  }

  async wait(requestId: string) {
    const run = this.runs.get(requestId.toLowerCase());
    if (!run) throw new DemoRequestError(404, "EXECUTION_NOT_FOUND");
    await run.finished;
    return this.get(requestId)!;
  }

  get(requestId: string) {
    requestId = requestId.toLowerCase();
    const run = this.runs.get(requestId);
    if (!run) return null;
    return structuredClone({ requestId, state: run.state, acceptedAt: run.acceptedAt, completedAt: run.completedAt,
      milestones: run.milestones, calls: { ...run.calls, solana: run.calls.anchor + run.calls.verifyAnchor },
      result: run.result ? publicExecution(run.result) : null,
      outputMediaUrl: run.result?.provenanceCreated && run.result.processingCompleted ? `/executions/${requestId}/output` : null,
    });
  }

  output(requestId: string) {
    const result = this.runs.get(requestId.toLowerCase())?.result;
    if (!result?.provenanceCreated || !result.processingCompleted || !result.processingResult || !result.provenance) return null;
    return { filePath: result.processingResult.outputFilePath, executionId: result.executionId!,
      outputContentHash: result.provenance.outputContentHash, outputSizeBytes: result.provenance.outputSizeBytes };
  }
}
