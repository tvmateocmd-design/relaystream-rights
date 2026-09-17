import {
  Connection,
  clusterApiUrl,
} from "@solana/web3.js";

import {
  hashProvenanceRecord,
  type ProvenanceRecord,
} from "./provenance";

export interface VerificationResult {
  verified: boolean;
  signature: string;
  computedHash: string;
  expectedMemo: string;
  onChainMemo: string;
}

export async function verifyProvenanceOnChain(
  signature: string,
  record: ProvenanceRecord
): Promise<VerificationResult> {
  const connection = new Connection(
    clusterApiUrl("devnet"),
    "confirmed"
  );

  // Independently recompute the SHA-256 fingerprint
  // from the provenance record being verified.
  const computedHash = hashProvenanceRecord(record);

  const expectedMemo =
    `relaystream-rights:v1:sha256:${computedHash}`;

  console.log("\n==============================");
  console.log("ON-CHAIN PROVENANCE VERIFIER");
  console.log("==============================");
  console.log("NETWORK: DEVNET");
  console.log("FETCHING TRANSACTION...");
  console.log(signature);

  const transaction = await connection.getTransaction(
    signature,
    {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    }
  );

  if (!transaction) {
    throw new Error(
      "Transaction was not found on Solana Devnet."
    );
  }

  console.log("\nTRANSACTION: FOUND");

  const logMessages =
    transaction.meta?.logMessages ?? [];

  const memoLog = logMessages.find((log) =>
    log.includes("relaystream-rights:v1:sha256:")
  );

  if (!memoLog) {
    throw new Error(
      "RelayStream Rights provenance memo was not found."
    );
  }

  console.log("\nON-CHAIN MEMO:");
  console.log(memoLog);

  console.log("\n==============================");
  console.log("PROVENANCE VERIFICATION");
  console.log("==============================");

  console.log("RECOMPUTED HASH:");
  console.log(computedHash);

  const hashMatches =
    memoLog.includes(expectedMemo);

  if (!hashMatches) {
    console.log("\nSTATUS: VERIFICATION FAILED");
    console.log("HASH MATCH: FALSE");

    return {
      verified: false,
      signature,
      computedHash,
      expectedMemo,
      onChainMemo: memoLog,
    };
  }

  console.log("\nSTATUS: VERIFIED");
  console.log("HASH MATCH: TRUE");

  return {
    verified: true,
    signature,
    computedHash,
    expectedMemo,
    onChainMemo: memoLog,
  };
}