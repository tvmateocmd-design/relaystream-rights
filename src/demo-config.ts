import path from "node:path";
import { registerMedia, type RegisteredMediaAsset, type RightsPolicy } from "./register-media";

export const DEMO_ASSET_ID = "relaystream-demo-001";
export const DEMO_POLICY: Readonly<RightsPolicy> = Object.freeze({
  policyId: "rsp-policy-001", commercialUse: "deny", aiTraining: "deny", derivatives: "allow",
  transcoding: "allow", attributionRequired: true, provenanceRequired: true,
});

export function demoConfiguration(workspaceRoot = process.cwd()) {
  const root = path.resolve(workspaceRoot);
  return Object.freeze({
    sourceRoot: path.join(root, "test-media"),
    sourceFile: path.join(root, "test-media", "relaystream-demo.mp4"),
    outputRoot: path.join(root, "generated-media"),
    frontendRoot: path.join(root, "public"),
  });
}

/** Explicit opt-in only. Never imports or runs the console demo. */
export function bootstrapDemo(assets: Map<string, RegisteredMediaAsset>, workspaceRoot = process.cwd()): RegisteredMediaAsset {
  if (assets.has(DEMO_ASSET_ID)) throw new Error("Demo asset is already registered.");
  const config = demoConfiguration(workspaceRoot);
  const asset = registerMedia({ assetId: DEMO_ASSET_ID, title: "RelayStream Demo Media", owner: "RelayStream",
    sourceUri: "relaystream://media/demo-001", sourceFilePath: config.sourceFile, policy: { ...DEMO_POLICY } });
  assets.set(asset.assetId, asset);
  return asset;
}
