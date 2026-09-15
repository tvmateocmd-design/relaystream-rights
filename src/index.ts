import {
  createProvenanceRecord,
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

const demoAsset: MediaAsset = {
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

function verifyPermission(
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

const requests: RightsAction[] = [
  "derivatives",
  "transcoding",
  "aiTraining",
  "commercialUse",
];

console.log("\nRELAYSTREAM RIGHTS");
console.log("==================");
console.log(`Asset: ${demoAsset.title}`);
console.log(`Owner: ${demoAsset.owner}`);
console.log(`Policy: ${demoAsset.policy.policyId}`);

for (const action of requests) {
  const result = verifyPermission(demoAsset, action);

  console.log("\n------------------------------");
  console.log(`ACTION: ${action}`);
  console.log(`DECISION: ${result.decision.toUpperCase()}`);
  console.log(`AUTHORIZED: ${result.authorized}`);
  console.log(`REASON: ${result.reason}`);

  if (result.authorized) {
    console.log(
      `ATTRIBUTION REQUIRED: ${result.attributionRequired}`
    );
    console.log(
      `PROVENANCE REQUIRED: ${result.provenanceRequired}`
    );
  }
}

function executeAuthorizedTransformation(
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

  const provenance = createProvenanceRecord(
    asset.assetId,
    derivedAssetId,
    asset.policy.policyId,
    action,
    asset.owner
  );

  console.log("STATUS: AUTHORIZED");
  console.log(`Derived Asset: ${derivedAssetId}`);
  console.log("PROVENANCE CREATED:");
  console.log(provenance);

  return provenance;
}

executeAuthorizedTransformation(
  demoAsset,
  "transcoding",
  "relaystream-demo-002"
);