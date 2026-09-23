import { createHash } from "node:crypto";

import type {
  RightsAction,
} from "./register-media";

export interface RoyaltyRecipient {
  role:
    | "creator"
    | "rightsholder"
    | "distributor"
    | "infrastructure";
  wallet: string;
  percentage: number;
}

export interface RoyaltyRule {
  royaltyRuleId: string;
  assetId: string;
  currency: string;
  recipients: RoyaltyRecipient[];
}

export interface RoyaltyAllocation {
  role: RoyaltyRecipient["role"];
  wallet: string;
  percentage: number;
  amount: number;
}

export interface CreateRoyaltyEventInput {
  assetId: string;
  action: RightsAction;
  derivedAssetId: string;
  provenanceId: string;
  provenanceHash: string;
  solanaSignature: string;
  authorized: boolean;
  usageAmount: number;
  royaltyRule: RoyaltyRule;
}

export interface RoyaltyEvent {
  royaltyEventId: string;
  royaltyRuleId: string;
  assetId: string;
  derivedAssetId: string;
  action: RightsAction;

  authorized: true;

  currency: string;
  usageAmount: number;

  provenanceId: string;
  provenanceHash: string;
  solanaSignature: string;

  allocations: RoyaltyAllocation[];
  totalAllocated: number;

  createdAt: string;
}

export interface RoyaltyProof {
  hashAlgorithm: "sha256";
  royaltyEventHash: string;
}

function roundCurrency(
  value: number
): number {
  return Math.round(
    (value + Number.EPSILON) * 100
  ) / 100;
}

export function validateRoyaltyRule(
  rule: RoyaltyRule
): void {
  if (!rule.royaltyRuleId) {
    throw new Error(
      "Royalty rule ID is required."
    );
  }

  if (!rule.assetId) {
    throw new Error(
      "Royalty rule asset ID is required."
    );
  }

  if (!rule.currency) {
    throw new Error(
      "Royalty currency is required."
    );
  }

  if (
    !Array.isArray(rule.recipients) ||
    rule.recipients.length === 0
  ) {
    throw new Error(
      "Royalty rule must contain at least one recipient."
    );
  }

  for (const recipient of rule.recipients) {
    if (!recipient.wallet) {
      throw new Error(
        `Wallet is required for ${recipient.role}.`
      );
    }

    if (
      !Number.isFinite(recipient.percentage) ||
      recipient.percentage <= 0
    ) {
      throw new Error(
        `Invalid percentage for ${recipient.role}.`
      );
    }
  }

  const totalPercentage =
    rule.recipients.reduce(
      (sum, recipient) =>
        sum + recipient.percentage,
      0
    );

  if (
    Math.abs(totalPercentage - 100) >
    0.000001
  ) {
    throw new Error(
      `Royalty percentages must total 100. Received ${totalPercentage}.`
    );
  }
}

export function createRoyaltyEvent(
  input: CreateRoyaltyEventInput
): RoyaltyEvent {
  if (!input.authorized) {
    throw new Error(
      "Royalty event rejected: media action was not authorized."
    );
  }

  if (
    !Number.isFinite(input.usageAmount) ||
    input.usageAmount <= 0
  ) {
    throw new Error(
      "Royalty usage amount must be greater than zero."
    );
  }

  if (
    input.royaltyRule.assetId !==
    input.assetId
  ) {
    throw new Error(
      "Royalty rule does not belong to this media asset."
    );
  }

  if (!input.provenanceId) {
    throw new Error(
      "Authorized royalty event requires provenance."
    );
  }

  if (!input.provenanceHash) {
    throw new Error(
      "Authorized royalty event requires a provenance hash."
    );
  }

  if (!input.solanaSignature) {
    throw new Error(
      "Authorized royalty event requires a Solana anchor signature."
    );
  }

  validateRoyaltyRule(
    input.royaltyRule
  );

  const allocations =
    input.royaltyRule.recipients.map(
      (recipient) => ({
        role: recipient.role,
        wallet: recipient.wallet,
        percentage:
          recipient.percentage,
        amount: roundCurrency(
          input.usageAmount *
            (recipient.percentage / 100)
        ),
      })
    );

  const totalAllocated =
    roundCurrency(
      allocations.reduce(
        (sum, allocation) =>
          sum + allocation.amount,
        0
      )
    );

  if (
    Math.abs(
      totalAllocated -
        roundCurrency(input.usageAmount)
    ) > 0.01
  ) {
    throw new Error(
      "Royalty allocation total does not match usage amount."
    );
  }

  return {
    royaltyEventId:
      `royalty-${input.provenanceId}`,

    royaltyRuleId:
      input.royaltyRule.royaltyRuleId,

    assetId:
      input.assetId,

    derivedAssetId:
      input.derivedAssetId,

    action:
      input.action,

    authorized: true,

    currency:
      input.royaltyRule.currency,

    usageAmount:
      roundCurrency(
        input.usageAmount
      ),

    provenanceId:
      input.provenanceId,

    provenanceHash:
      input.provenanceHash,

    solanaSignature:
      input.solanaSignature,

    allocations,

    totalAllocated,

    createdAt:
      new Date().toISOString(),
  };
}

export function hashRoyaltyEvent(
  event: RoyaltyEvent
): RoyaltyProof {
  const canonicalEvent =
    JSON.stringify({
      royaltyEventId:
        event.royaltyEventId,
      royaltyRuleId:
        event.royaltyRuleId,
      assetId:
        event.assetId,
      derivedAssetId:
        event.derivedAssetId,
      action:
        event.action,
      authorized:
        event.authorized,
      currency:
        event.currency,
      usageAmount:
        event.usageAmount,
      provenanceId:
        event.provenanceId,
      provenanceHash:
        event.provenanceHash,
      solanaSignature:
        event.solanaSignature,
      allocations:
        event.allocations.map(
          (allocation) => ({
            role:
              allocation.role,
            wallet:
              allocation.wallet,
            percentage:
              allocation.percentage,
            amount:
              allocation.amount,
          })
        ),
      totalAllocated:
        event.totalAllocated,
      createdAt:
        event.createdAt,
    });

  const royaltyEventHash =
    createHash("sha256")
      .update(canonicalEvent)
      .digest("hex");

  return {
    hashAlgorithm: "sha256",
    royaltyEventHash,
  };
}