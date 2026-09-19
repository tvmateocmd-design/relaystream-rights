import fs from "node:fs";

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
}

export interface RegisterMediaInput {
  assetId: string;
  title: string;
  owner: string;
  sourceUri: string;
  sourceFilePath: string;
  policy: RightsPolicy;
}

export function registerMedia(
  input: RegisterMediaInput
): RegisteredMediaAsset {
  const mediaContent =
    fs.readFileSync(input.sourceFilePath);

  const sourceContentHash =
    hashMediaContent(mediaContent);

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