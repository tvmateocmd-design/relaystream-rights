import fs from "node:fs";
import { createHash } from "node:crypto";
import { createDemoRoyaltyRule, prepareRoyaltyRequest, type RoyaltyRule } from "./royalties";

import {
  hashMediaContent,
} from "./provenance";

export type Permission = "allow" | "deny";

export type RightsAction =
  | "commercialUse"
  | "aiTraining"
  | "derivatives"
  | "transcoding";

export interface RightsPolicy {
  policyId: string;
  commercialUse: Permission;
  aiTraining: Permission;
  derivatives: Permission;
  transcoding: Permission;
  attributionRequired: boolean;
  provenanceRequired: boolean;
}

export interface RegisteredMediaAsset {
  assetId: string;
  title: string;
  owner: string;
  sourceUri: string;
  sourceFilePath: string;
  sourceContentHash: string;
  sourceSizeBytes: number;
  hashAlgorithm: "sha256";
  policy: RightsPolicy;
  policyHash: string;
  royaltyRule: RoyaltyRule;
}

export interface RegisterMediaInput {
  assetId: string;
  title: string;
  owner: string;
  sourceUri: string;
  sourceFilePath: string;
  policy: RightsPolicy;
  royaltyRule?: RoyaltyRule;
}

export function hashRightsPolicy(
  policy: RightsPolicy
): string {
  const canonicalPolicy = JSON.stringify({
    policyId: policy.policyId,
    commercialUse: policy.commercialUse,
    aiTraining: policy.aiTraining,
    derivatives: policy.derivatives,
    transcoding: policy.transcoding,
    attributionRequired:
      policy.attributionRequired,
    provenanceRequired:
      policy.provenanceRequired,
  });

  return createHash("sha256")
    .update(canonicalPolicy)
    .digest("hex");
}

export function registerMedia(
  input: RegisterMediaInput
): RegisteredMediaAsset {
  const royaltyRule = structuredClone(input.royaltyRule ?? createDemoRoyaltyRule(input.assetId));
  prepareRoyaltyRequest(royaltyRule, input.assetId);
  const mediaContent =
    fs.readFileSync(input.sourceFilePath);

  const sourceContentHash =
    hashMediaContent(mediaContent);

  const policyHash =
    hashRightsPolicy(input.policy);

  const asset: RegisteredMediaAsset = {
    assetId: input.assetId,
    title: input.title,
    owner: input.owner,
    sourceUri: input.sourceUri,
    sourceFilePath: input.sourceFilePath,
    sourceContentHash,
    sourceSizeBytes: mediaContent.length,
    hashAlgorithm: "sha256",
    policy: input.policy,
    policyHash,
    royaltyRule,
  };

  console.log("\n======================================");
  console.log("MEDIA REGISTRATION");
  console.log("======================================");

  console.log(`ASSET: ${asset.assetId}`);
  console.log(`TITLE: ${asset.title}`);
  console.log(`OWNER: ${asset.owner}`);
  console.log(`FILE: ${asset.sourceFilePath}`);
  console.log(`SIZE: ${asset.sourceSizeBytes} bytes`);

  console.log("\nMEDIA FINGERPRINT");
  console.log(`HASH ALGORITHM: ${asset.hashAlgorithm}`);
  console.log(
    `CONTENT SHA-256: ${asset.sourceContentHash}`
  );

  console.log("\nRIGHTS POLICY ATTACHED");
  console.log(`POLICY: ${asset.policy.policyId}`);
  console.log(
    `POLICY SHA-256: ${asset.policyHash}`
  );
  console.log(
    `AI TRAINING: ${asset.policy.aiTraining.toUpperCase()}`
  );
  console.log(
    `TRANSCODING: ${asset.policy.transcoding.toUpperCase()}`
  );
  console.log(
    `DERIVATIVES: ${asset.policy.derivatives.toUpperCase()}`
  );
  console.log(
    `COMMERCIAL USE: ${asset.policy.commercialUse.toUpperCase()}`
  );
  console.log(
    `ATTRIBUTION REQUIRED: ${asset.policy.attributionRequired}`
  );
  console.log(
    `PROVENANCE REQUIRED: ${asset.policy.provenanceRequired}`
  );

  console.log("\nREGISTRATION STATUS: REGISTERED");

  return asset;
}
