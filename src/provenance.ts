import { createHash } from "node:crypto";

export type ProvenanceAction = "derivatives" | "transcoding";

export interface ProvenanceRecord {
  provenanceId: string;
  sourceAssetId: string;
  derivedAssetId: string;
  policyId: string;
  action: ProvenanceAction;
  owner: string;
  createdAt: string;
}

export interface ProvenanceProof {
  record: ProvenanceRecord;
  hashAlgorithm: "sha256";
  provenanceHash: string;
}

export function createProvenanceRecord(
  sourceAssetId: string,
  derivedAssetId: string,
  policyId: string,
  action: ProvenanceAction,
  owner: string
): ProvenanceRecord {
  return {
    provenanceId: `prov-${sourceAssetId}-${derivedAssetId}`,
    sourceAssetId,
    derivedAssetId,
    policyId,
    action,
    owner,
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
    action: record.action,
    owner: record.owner,
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
    provenanceHash: hashProvenanceRecord(record),
  };
}