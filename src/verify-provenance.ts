import {
  Connection,
  clusterApiUrl,
} from "@solana/web3.js";

export interface VerificationResult {
  verified: boolean;
  signature: string;
  expectedHash: string;
  memo: string;
}

export async function verifyProvenanceOnChain(
  signature: string,
  expectedHash: string
): Promise<VerificationResult> {
  const connection = new Connection(
    clusterApiUrl("devnet"),
    "confirmed"
  );

  const expectedMemo =
    `relaystream-rights:v1:sha256:${expectedHash}`;

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

  const hashMatches =
    memoLog.includes(expectedMemo);

  console.log("\n==============================");
  console.log("PROVENANCE VERIFICATION");
  console.log("==============================");

  console.log("EXPECTED HASH:");
  console.log(expectedHash);

  if (!hashMatches) {
    console.log("\nSTATUS: VERIFICATION FAILED");
    console.log("HASH MATCH: FALSE");

    throw new Error(
      "On-chain provenance hash does not match expected hash."
    );
  }

  console.log("\nSTATUS: VERIFIED");
  console.log("HASH MATCH: TRUE");

  return {
    verified: true,
    signature,
    expectedHash,
    memo: expectedMemo,
  };
}