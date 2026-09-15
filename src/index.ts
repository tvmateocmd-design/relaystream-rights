type Permission = "allow" | "deny";

interface MediaRights {
  assetId: string;
  owner: string;
  commercialUse: Permission;
  aiTraining: Permission;
  derivatives: Permission;
}

const demoAsset: MediaRights = {
  assetId: "relaystream-demo-001",
  owner: "RelayStream",
  commercialUse: "deny",
  aiTraining: "deny",
  derivatives: "allow",
};

function verifyPermission(
  rights: MediaRights,
  action: "commercialUse" | "aiTraining" | "derivatives"
): Permission {
  return rights[action];
}

console.log(
  "Derivative creation:",
  verifyPermission(demoAsset, "derivatives")
);

console.log(
  "AI training:",
  verifyPermission(demoAsset, "aiTraining")
);