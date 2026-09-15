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