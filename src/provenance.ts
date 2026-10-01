import { createHash } from "node:crypto";
import { TRANSCODE_PROFILE, type TranscodeResult } from "./transcode-media";
import { verifyOutputContent } from "./verify-output";

export type ProvenanceAction =
  | "derivatives"
  | "transcoding";

export interface LegacyProvenanceRecord {
  schemaVersion?: 1;
  provenanceId: string;
  sourceAssetId: string;
  derivedAssetId: string;

  // Identifies the rights policy used to authorize
  // this transformation.
  policyId: string;

  // SHA-256 fingerprint of the exact rights policy
  // used when this provenance record was created.
  policyHash: string;

  action: ProvenanceAction;
  owner: string;

  // SHA-256 fingerprint of the source media content.
  sourceContentHash: string;

  createdAt: string;
}

export interface ProvenanceV2Record extends Readonly<Omit<LegacyProvenanceRecord, "schemaVersion" | "action">> {
  readonly schemaVersion: 2;
  readonly executionId: string;
  readonly action: "transcoding";
  readonly outputContentHash: string;
  readonly outputSizeBytes: number;
  readonly processing: Readonly<TranscodeResult["processing"]>;
}

export type ProvenanceRecord = LegacyProvenanceRecord | ProvenanceV2Record;

export interface ProvenanceProof<T extends ProvenanceRecord = ProvenanceRecord> {
  readonly record: T;
  readonly hashAlgorithm: "sha256";
  readonly provenanceHash: string;
}

/** Contains execution-owned snapshots only; no registry/asset reference is needed. */
export interface CompletedMediaProcessing {
  readonly status: "processed";
  readonly processorInvoked: true;
  readonly processingCompleted: true;
  readonly assetId: string;
  readonly derivedAssetId: string;
  readonly action: ProvenanceAction;
  readonly executionId: string;
  readonly authorization: {
    readonly assetId: string;
    readonly sourceContentHash: string;
    readonly policyId: string;
    readonly owner: string;
    readonly action: string;
    readonly decision: string;
    readonly authorized: boolean;
    readonly policyIntegrityValid: boolean;
    readonly registeredPolicyHash: string;
    readonly currentPolicyHash: string;
  };
  readonly processingResult: TranscodeResult;
}

export class ProvenanceError extends Error {
  constructor(
    public readonly code: "INVALID_COMPLETION" | "OUTPUT_VERIFICATION_FAILED" | "PROOF_VERIFICATION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "ProvenanceError";
  }
}

/*
 * Create a SHA-256 fingerprint from media content.
 */
export function hashMediaContent(
  content: Buffer
): string {
  return createHash("sha256")
    .update(content)
    .digest("hex");
}

export function createProvenanceRecord(
  sourceAssetId: string,
  derivedAssetId: string,
  policyId: string,
  policyHash: string,
  action: ProvenanceAction,
  owner: string,
  sourceContentHash: string
): LegacyProvenanceRecord {
  return {
    provenanceId:
      `prov-${sourceAssetId}-${derivedAssetId}`,
    sourceAssetId,
    derivedAssetId,
    policyId,
    policyHash,
    action,
    owner,
    sourceContentHash,
    createdAt: new Date().toISOString(),
  };
}

export function serializeProvenanceRecord(
  record: ProvenanceRecord
): string {
  if (record.schemaVersion === 2) {
    const p = record.processing;
    const profile = p.profile;
    // Ordered named pairs are the v2 wire format. No input object enumeration.
    return JSON.stringify([
      ["schemaVersion", record.schemaVersion],
      ["provenanceId", record.provenanceId],
      ["executionId", record.executionId],
      ["sourceAssetId", record.sourceAssetId],
      ["derivedAssetId", record.derivedAssetId],
      ["policyId", record.policyId],
      ["policyHash", record.policyHash],
      ["action", record.action],
      ["owner", record.owner],
      ["sourceContentHash", record.sourceContentHash],
      ["outputContentHash", record.outputContentHash],
      ["outputSizeBytes", record.outputSizeBytes],
      ["processing", [
        ["tool", p.tool], ["toolVersion", p.toolVersion], ["probeVersion", p.probeVersion],
        ["profile", [
          ["profileId", profile.profileId], ["format", profile.format],
          ["videoEncoder", profile.videoEncoder], ["width", profile.width],
          ["crf", profile.crf], ["preset", profile.preset], ["pixelFormat", profile.pixelFormat],
          ["audioEncoder", profile.audioEncoder], ["audioBitrate", profile.audioBitrate],
          ["faststart", profile.faststart],
        ]],
        ["startedAt", p.startedAt], ["completedAt", p.completedAt],
        ["outputFormat", p.outputFormat], ["videoCodec", p.videoCodec], ["audioCodec", p.audioCodec],
        ["pixelFormat", p.pixelFormat], ["width", p.width], ["height", p.height], ["durationMs", p.durationMs],
      ]],
      ["createdAt", record.createdAt],
    ]);
  }
  if (record.schemaVersion !== undefined && record.schemaVersion !== 1) {
    throw new Error("Unsupported provenance schema version.");
  }
  // Preserve the original legacy bytes, field order, and omissions exactly.
  return JSON.stringify({
    provenanceId: record.provenanceId,
    sourceAssetId: record.sourceAssetId,
    derivedAssetId: record.derivedAssetId,
    policyId: record.policyId,
    policyHash: record.policyHash,
    action: record.action,
    owner: record.owner,
    sourceContentHash: record.sourceContentHash,
    createdAt: record.createdAt,
  });
}

export function hashProvenanceRecord(record: ProvenanceRecord): string {
  const canonicalRecord = serializeProvenanceRecord(record);

  return createHash("sha256")
    .update(canonicalRecord)
    .digest("hex");
}

export function createProvenanceProof<T extends ProvenanceRecord>(
  record: T
): ProvenanceProof<T> {
  return {
    record,
    hashAlgorithm: "sha256",
    provenanceHash:
      hashProvenanceRecord(record),
  };
}

export function verifyProvenanceProof(proof: ProvenanceProof): boolean {
  try {
    return proof.hashAlgorithm === "sha256" && /^[a-f0-9]{64}$/.test(proof.provenanceHash) &&
      hashProvenanceRecord(proof.record) === proof.provenanceHash;
  } catch {
    return false;
  }
}

function validateCompletion(completed: CompletedMediaProcessing): void {
  if (completed.status !== "processed" || !completed.authorization || !completed.processingResult?.processing) {
    throw new ProvenanceError("INVALID_COMPLETION", "Provenance v2 requires successful media processing.");
  }
  const a = completed.authorization;
  const output = completed.processingResult;
  const p = output.processing;
  const hashes = [a.sourceContentHash, a.registeredPolicyHash, a.currentPolicyHash, output.sourceContentHash, output.outputContentHash];
  const identities = [completed.assetId, completed.derivedAssetId, completed.executionId, a.policyId, a.owner];
  const validTimestamp = (value: string) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  if (
    completed.status !== "processed" || completed.processorInvoked !== true || completed.processingCompleted !== true ||
    a.authorized !== true || a.policyIntegrityValid !== true || a.decision !== "allow" ||
    completed.action !== "transcoding" || a.action !== completed.action || a.assetId !== completed.assetId ||
    a.registeredPolicyHash !== a.currentPolicyHash || a.sourceContentHash !== output.sourceContentHash ||
    completed.executionId !== output.executionId || output.hashAlgorithm !== "sha256" ||
    !identities.every((value) => typeof value === "string" && value.trim().length > 0) ||
    !hashes.every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) ||
    !Number.isSafeInteger(output.outputSizeBytes) || output.outputSizeBytes <= 0 ||
    p.tool !== "ffmpeg" || typeof p.toolVersion !== "string" || !p.toolVersion.startsWith("ffmpeg version ") ||
    typeof p.probeVersion !== "string" || !p.probeVersion.startsWith("ffprobe version ") ||
    !p.profile || !(Object.keys(TRANSCODE_PROFILE) as (keyof typeof TRANSCODE_PROFILE)[]).every((key) => p.profile[key] === TRANSCODE_PROFILE[key]) ||
    p.outputFormat !== "mp4" || p.videoCodec !== "h264" || (p.audioCodec !== "aac" && p.audioCodec !== null) ||
    p.pixelFormat !== "yuv420p" || p.width !== p.profile.width ||
    !Number.isSafeInteger(p.height) || p.height <= 0 || p.height % 2 !== 0 ||
    !Number.isSafeInteger(p.durationMs) || p.durationMs <= 0 ||
    !validTimestamp(p.startedAt) || !validTimestamp(p.completedAt) || Date.parse(p.startedAt) > Date.parse(p.completedAt)
  ) {
    throw new ProvenanceError("INVALID_COMPLETION", "Provenance v2 requires matching authorized snapshots and validated, completed processing metadata.");
  }
}

/** No record is constructed until authorization, metadata and output bytes pass. */
export async function createProvenanceV2Proof(
  completion: CompletedMediaProcessing,
): Promise<ProvenanceProof<ProvenanceV2Record>> {
  // Protect the provenance input while independent file verification awaits IO.
  const completed = structuredClone(completion);
  validateCompletion(completed);
  const output = completed.processingResult;
  const verification = await verifyOutputContent(output.outputFilePath, output);
  if (!verification.verified) {
    throw new ProvenanceError("OUTPUT_VERIFICATION_FAILED", verification.reason);
  }
  const a = completed.authorization;
  const p = output.processing;
  const profile = Object.freeze({
    profileId: p.profile.profileId, format: p.profile.format,
    videoEncoder: p.profile.videoEncoder, width: p.profile.width,
    crf: p.profile.crf, preset: p.profile.preset, pixelFormat: p.profile.pixelFormat,
    audioEncoder: p.profile.audioEncoder, audioBitrate: p.profile.audioBitrate, faststart: p.profile.faststart,
  });
  const processing = Object.freeze({
    tool: p.tool, toolVersion: p.toolVersion, probeVersion: p.probeVersion, profile,
    startedAt: p.startedAt, completedAt: p.completedAt,
    outputFormat: p.outputFormat, videoCodec: p.videoCodec, audioCodec: p.audioCodec,
    pixelFormat: p.pixelFormat, width: p.width, height: p.height, durationMs: p.durationMs,
  });
  const record: ProvenanceV2Record = Object.freeze({
    schemaVersion: 2, provenanceId: `prov-${completed.executionId}`, executionId: completed.executionId,
    sourceAssetId: completed.assetId, derivedAssetId: completed.derivedAssetId,
    policyId: a.policyId, policyHash: a.registeredPolicyHash, action: "transcoding", owner: a.owner,
    sourceContentHash: a.sourceContentHash, outputContentHash: output.outputContentHash,
    outputSizeBytes: output.outputSizeBytes, processing,
    // Use the completion event's timestamp, so identical inputs produce identical records.
    createdAt: p.completedAt,
  });
  const proof = Object.freeze(createProvenanceProof(record));
  if (!verifyProvenanceProof(proof)) {
    throw new ProvenanceError("PROOF_VERIFICATION_FAILED", "Created provenance proof failed independent hash verification.");
  }
  return proof;
}
