import { createHash } from "node:crypto";

export type ProvenanceAction =
  | "derivatives"
  | "transcoding";

export interface ProvenanceRecord {
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

export interface ProvenanceProof {
  record: ProvenanceRecord;
  hashAlgorithm: "sha256";
  provenanceHash: string;
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
): ProvenanceRecord {
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

export function hashProvenanceRecord(
  record: ProvenanceRecord
): string {
  const canonicalRecord = JSON.stringify({
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

  return createHash("sha256")
    .update(canonicalRecord)
    .digest("hex");
}

export function createProvenanceProof(
  record: ProvenanceRecord
): ProvenanceProof {
  return {
    record,
    hashAlgorithm: "sha256",
    provenanceHash:
      hashProvenanceRecord(record),
  };
}