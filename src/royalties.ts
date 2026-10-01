import { createHash } from "node:crypto";
import { DEVNET_ENDPOINT, DEVNET_GENESIS_HASH, provenanceMemo } from "./anchor-provenance";
import { verifyProvenanceProof } from "./provenance";
import type { ExecutionResult, AnchorReceipt } from "./index";
import type { ProvenanceProof, ProvenanceV2Record } from "./provenance";
import { FileRoyaltyEventStore, type RoyaltyEventStore } from "./royalty-event-store";

export interface RoyaltyRecipient {
  role: "creator" | "rightsholder" | "distributor" | "infrastructure";
  wallet: string;
  percentage: number;
}
export interface RoyaltyRule {
  royaltyRuleId: string;
  assetId: string;
  currency: string;
  recipients: RoyaltyRecipient[];
}
export interface PreparedRoyaltyRequest {
  readonly rule: Readonly<Omit<RoyaltyRule, "recipients">> & { readonly recipients: readonly Readonly<RoyaltyRecipient>[] };
  readonly usageAmountMinorUnits: number;
  readonly usageAmount: string;
}
export interface RoyaltyAllocation extends Readonly<RoyaltyRecipient> {
  readonly basisPoints: number;
  readonly amountMinorUnits: number;
  readonly amount: string;
}
export interface RoyaltyEvent {
  readonly schemaVersion: 2;
  readonly royaltyEventId: string;
  readonly executionId: string;
  readonly royaltyRuleId: string;
  readonly assetId: string;
  readonly derivedAssetId: string;
  readonly action: "transcoding";
  readonly authorized: true;
  readonly currency: string;
  readonly minorUnitScale: 100;
  readonly usageAmountMinorUnits: number;
  readonly usageAmount: string;
  readonly provenanceId: string;
  readonly provenanceHash: string;
  readonly solanaSignature: string;
  readonly verifiedAuthority: string;
  readonly allocations: readonly Readonly<RoyaltyAllocation>[];
  readonly totalAllocatedMinorUnits: number;
  readonly totalAllocated: string;
  readonly remainderMethod: "largest-remainder-recipient-order";
  readonly allocationOnly: true;
  readonly fundsTransferred: false;
  readonly createdAt: string;
}
export interface RoyaltyProof { readonly hashAlgorithm: "sha256"; readonly royaltyEventHash: string; }
export interface RoyaltyReceipt {
  readonly event: RoyaltyEvent;
  readonly proof: RoyaltyProof;
  readonly created: boolean;
  readonly cleanupWarning?: string;
}

export class RoyaltyError extends Error {
  constructor(readonly code: "INVALID_ROYALTY_REQUEST" | "UNVERIFIED_EXECUTION" | "IDEMPOTENCY_CONFLICT" | "ROYALTY_STORE_FAILED", message: string) {
    super(message); this.name = "RoyaltyError";
  }
}

export function createDemoRoyaltyRule(assetId: string): RoyaltyRule {
  return {
    royaltyRuleId: `relaystream-demo-royalty-rule-${assetId}`, assetId, currency: "USD-DEMO",
    recipients: [
      { role: "creator", wallet: "3Ywmj3aKMe2Ti5wSz4x2mfZ2GJJdC8HpdXnbunPB4bQA", percentage: 60 },
      { role: "rightsholder", wallet: "84ybGHDF7zPAr5aa8Hx3xS4wRZ6u2S5LPvtUdPuPBKfH", percentage: 20 },
      { role: "distributor", wallet: "GuYsfNxu29BZBa32FSJf2URodPK617uwUX63mUudPPzn", percentage: 10 },
      { role: "infrastructure", wallet: "nQGn7dXP1hN7XzJ7zP3UtML3HfUuGCtNipgmtL4j8ZZ", percentage: 10 },
    ],
  };
}

function invalid(message: string): never { throw new RoyaltyError("INVALID_ROYALTY_REQUEST", message); }
// Parse decimal text exactly; never round a requested amount or multiply floating currency values.
function decimalHundredths(value: number | string): number {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || text.length > 17) return invalid("Amount exceeds the supported decimal range.");
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return invalid("Amounts and percentages require nonnegative decimal values with at most two decimal places.");
  const minor = BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return invalid("Amount exceeds the safe integer minor-unit range.");
  return Number(minor);
}
function displayAmount(minor: number): string { const value = BigInt(minor); return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`; }

export function validateRoyaltyRule(rule: RoyaltyRule): void {
  if (!rule || !rule.royaltyRuleId?.trim() || !rule.assetId?.trim() || !rule.currency?.trim()) invalid("Royalty rule ID, asset ID and currency are required.");
  if (!Array.isArray(rule.recipients) || !rule.recipients.length) invalid("Royalty recipients are required.");
  const seen = new Set<string>();
  let total = 0;
  for (const recipient of rule.recipients) {
    if (!["creator", "rightsholder", "distributor", "infrastructure"].some(role => role === recipient.role)
      || !recipient.wallet?.trim()) invalid("A supported role and recipient identifier are required.");
    const key = JSON.stringify([recipient.role, recipient.wallet]);
    if (seen.has(key)) invalid("Duplicate royalty recipient.");
    seen.add(key);
    if (typeof recipient.percentage !== "number") invalid("Recipient percentages must be numeric.");
    const basisPoints = decimalHundredths(recipient.percentage);
    if (basisPoints <= 0 || basisPoints > 10_000) invalid("Recipient percentages must be positive and no greater than 100.");
    total += basisPoints;
  }
  if (total !== 10_000) invalid("Royalty percentages must total exactly 100.");
}

export function prepareRoyaltyRequest(rule: RoyaltyRule, assetId: string, usageAmount: number | string = 100): PreparedRoyaltyRequest {
  const snapshot = structuredClone(rule);
  validateRoyaltyRule(snapshot);
  if (snapshot.assetId !== assetId) invalid("Royalty rule does not belong to the executing asset.");
  const usageAmountMinorUnits = decimalHundredths(usageAmount);
  if (usageAmountMinorUnits <= 0) invalid("Usage amount must be greater than zero.");
  const recipients = Object.freeze(snapshot.recipients.map(recipient => Object.freeze(recipient)));
  return Object.freeze({ rule: Object.freeze({ ...snapshot, recipients }), usageAmountMinorUnits, usageAmount: displayAmount(usageAmountMinorUnits) });
}

export function hashRoyaltyEvent(event: RoyaltyEvent): RoyaltyProof {
  const bytes = JSON.stringify([
    ["schemaVersion", event.schemaVersion], ["royaltyEventId", event.royaltyEventId], ["executionId", event.executionId],
    ["royaltyRuleId", event.royaltyRuleId], ["assetId", event.assetId], ["derivedAssetId", event.derivedAssetId],
    ["action", event.action], ["authorized", event.authorized], ["currency", event.currency], ["minorUnitScale", event.minorUnitScale],
    ["usageAmountMinorUnits", event.usageAmountMinorUnits], ["usageAmount", event.usageAmount], ["provenanceId", event.provenanceId],
    ["provenanceHash", event.provenanceHash], ["solanaSignature", event.solanaSignature], ["verifiedAuthority", event.verifiedAuthority],
    ["allocations", event.allocations.map(a => [a.role, a.wallet, a.percentage, a.basisPoints, a.amountMinorUnits, a.amount])],
    ["totalAllocatedMinorUnits", event.totalAllocatedMinorUnits], ["totalAllocated", event.totalAllocated],
    ["remainderMethod", event.remainderMethod], ["allocationOnly", event.allocationOnly], ["fundsTransferred", event.fundsTransferred], ["createdAt", event.createdAt],
  ]);
  return Object.freeze({ hashAlgorithm: "sha256", royaltyEventHash: createHash("sha256").update(bytes).digest("hex") });
}

export type RoyaltyExecution = Pick<ExecutionResult, "assetId" | "derivedAssetId" | "action" | "authorization" | "executionId"
  | "processingCompleted" | "provenanceCreated" | "proof" | "solanaAnchored" | "solanaSignature" | "anchor">;
function requireVerifiedExecution(execution: RoyaltyExecution): asserts execution is RoyaltyExecution & {
  executionId: string; solanaSignature: string; proof: ProvenanceProof<ProvenanceV2Record>; anchor: AnchorReceipt;
} {
  const v = execution.anchor?.verification;
  const p = execution.proof;
  const a = execution.authorization;
  if (!execution.solanaAnchored || !execution.provenanceCreated || !p || !verifyProvenanceProof(p) || p.record.schemaVersion !== 2
    || !execution.processingCompleted || !a.authorized || !a.policyIntegrityValid || a.decision !== "allow"
    || execution.executionId !== p.record.executionId || execution.assetId !== p.record.sourceAssetId
    || execution.derivedAssetId !== p.record.derivedAssetId || execution.action !== p.record.action || a.owner !== p.record.owner
    || a.assetId !== p.record.sourceAssetId || a.policyId !== p.record.policyId || a.action !== p.record.action
    || a.sourceContentHash !== p.record.sourceContentHash || a.registeredPolicyHash !== p.record.policyHash
    || a.currentPolicyHash !== p.record.policyHash || execution.anchor?.state !== "verified" || execution.anchor.transactionStatus !== "confirmed"
    || !execution.solanaSignature || execution.anchor.signature !== execution.solanaSignature
    || !v?.verified || !v.transactionSucceeded || v.signature !== execution.solanaSignature || v.computedHash !== p.provenanceHash
    || v.expectedMemo !== provenanceMemo(p.provenanceHash, 2) || v.onChainMemo !== v.expectedMemo
    || v.expectedAuthority !== execution.anchor.expectedAuthority || v.verifiedAuthority !== v.expectedAuthority
    || !v.verifiedAuthority || v.network !== "devnet" || v.rpcEndpoint !== DEVNET_ENDPOINT || v.genesisHash !== DEVNET_GENESIS_HASH) {
    throw new RoyaltyError("UNVERIFIED_EXECUTION", "Allocation requires an authorized, completed v2 proof and independently verified confirmed Devnet anchor.");
  }
}

export async function createRoyaltyEvent(
  execution: RoyaltyExecution,
  request: PreparedRoyaltyRequest,
  store: RoyaltyEventStore = new FileRoyaltyEventStore("royalty-ledger"),
): Promise<RoyaltyReceipt> {
  requireVerifiedExecution(execution);
  // Revalidate even a prepared request supplied by another caller; detach it before awaiting storage.
  const prepared = prepareRoyaltyRequest(structuredClone(request.rule) as RoyaltyRule, execution.assetId, request.usageAmount);
  if (prepared.usageAmountMinorUnits !== request.usageAmountMinorUnits) invalid("Prepared amount does not match its minor-unit value.");
  const total = BigInt(prepared.usageAmountMinorUnits);
  const shares = prepared.rule.recipients.map((recipient, index) => {
    const basisPoints = decimalHundredths(recipient.percentage);
    const product = total * BigInt(basisPoints);
    return { recipient, index, basisPoints, minor: product / 10_000n, remainder: product % 10_000n };
  });
  const remaining = Number(total - shares.reduce((sum, share) => sum + share.minor, 0n));
  const ranked = [...shares].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (let i = 0; i < remaining; i++) ranked[i]!.minor += 1n;
  const allocations = Object.freeze(shares.map(({ recipient, basisPoints, minor }) => Object.freeze({
    ...recipient, basisPoints, amountMinorUnits: Number(minor), amount: displayAmount(Number(minor)),
  })));
  const totalAllocatedMinorUnits = allocations.reduce((sum, allocation) => sum + allocation.amountMinorUnits, 0);
  if (totalAllocatedMinorUnits !== prepared.usageAmountMinorUnits) invalid("Allocation failed exact minor-unit conservation.");
  const event: RoyaltyEvent = Object.freeze({
    schemaVersion: 2, royaltyEventId: `royalty-${execution.executionId}`, executionId: execution.executionId,
    royaltyRuleId: prepared.rule.royaltyRuleId, assetId: execution.assetId, derivedAssetId: execution.derivedAssetId,
    action: "transcoding", authorized: true, currency: prepared.rule.currency, minorUnitScale: 100,
    usageAmountMinorUnits: prepared.usageAmountMinorUnits, usageAmount: prepared.usageAmount,
    provenanceId: execution.proof.record.provenanceId, provenanceHash: execution.proof.provenanceHash,
    solanaSignature: execution.solanaSignature, verifiedAuthority: execution.anchor.verification!.verifiedAuthority!,
    allocations, totalAllocatedMinorUnits, totalAllocated: displayAmount(totalAllocatedMinorUnits),
    remainderMethod: "largest-remainder-recipient-order", allocationOnly: true, fundsTransferred: false,
    createdAt: new Date().toISOString(),
  });
  return store.record(event, hashRoyaltyEvent(event));
}
