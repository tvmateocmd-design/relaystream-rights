import path from "node:path";

import {
  registerMedia,
  type RightsPolicy,
} from "./register-media";

import {
  verifyPermission,
} from "./index";

const originalPolicy: RightsPolicy = {
  policyId: "rsp-policy-tamper-test-001",
  commercialUse: "deny",
  aiTraining: "deny",
  derivatives: "deny",
  transcoding: "deny",
  attributionRequired: true,
  provenanceRequired: true,
};

const asset = registerMedia({
  assetId: "relaystream-policy-tamper-test-001",
  title: "RelayStream Policy Tamper Test",
  owner: "RelayStream",
  sourceUri: "local://relaystream-demo.mp4",
  sourceFilePath: path.resolve(
    "./test-media/relaystream-demo.mp4"
  ),
  policy: originalPolicy,
});

console.log("");
console.log("======================================");
console.log("POLICY TAMPER TEST");
console.log("======================================");

console.log("");
console.log("REGISTERED POLICY");
console.log("--------------------------------------");
console.log(
  `TRANSCODING: ${asset.policy.transcoding.toUpperCase()}`
);
console.log(
  `REGISTERED POLICY SHA-256: ${asset.policyHash}`
);

/*
 * Simulate unauthorized modification after
 * registration.
 *
 * The registered policy explicitly DENIED
 * transcoding. We now alter the in-memory
 * policy to claim that transcoding is allowed.
 *
 * The original registered policy hash is
 * intentionally left unchanged.
 */
asset.policy.transcoding = "allow";

console.log("");
console.log("POLICY AFTER TAMPERING");
console.log("--------------------------------------");
console.log(
  `TRANSCODING: ${asset.policy.transcoding.toUpperCase()}`
);

const result =
  verifyPermission(
    asset,
    "transcoding"
  );

console.log("");
console.log("INTEGRITY VERIFICATION");
console.log("--------------------------------------");
console.log(
  `REGISTERED POLICY SHA-256: ${result.registeredPolicyHash}`
);
console.log(
  `CURRENT POLICY SHA-256:    ${result.currentPolicyHash}`
);
console.log(
  `INTEGRITY: ${
    result.policyIntegrityValid
      ? "VERIFIED"
      : "FAILED"
  }`
);

console.log("");
console.log("AUTHORIZATION RESULT");
console.log("--------------------------------------");
console.log(
  `DECISION: ${result.decision.toUpperCase()}`
);
console.log(
  `AUTHORIZED: ${result.authorized}`
);
console.log(
  `REASON: ${result.reason}`
);

console.log("");
console.log("EXPECTED SECURITY BEHAVIOR");
console.log("--------------------------------------");

if (
  result.policyIntegrityValid === false &&
  result.authorized === false &&
  result.decision === "deny"
) {
  console.log("PASS: TAMPERED POLICY FAILED CLOSED.");
  console.log("NO AUTHORIZED ACTION.");
  console.log("NO PROVENANCE.");
  console.log("NO SOLANA ANCHOR.");
  console.log("NO ROYALTY EVENT.");
  process.exit(0);
}

console.error(
  "FAIL: TAMPERED POLICY WAS NOT BLOCKED."
);

process.exit(1);