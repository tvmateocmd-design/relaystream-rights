import {
  Connection,
  clusterApiUrl,
} from "@solana/web3.js";

const TRANSACTION_SIGNATURE =
  "37wLEh4L2xC3oyYZuQx1xYzjDFP1Y7v2XEMbpaEf3aZhXhwiHBwuSip9scNx6XSrg73on7kh8dbFo8fVDwBJgx2b";

const EXPECTED_PROVENANCE_HASH =
  "5b53dc6c3a29bd694d0e75f91e7658fe2bbffab72e66acc0d32f41d00ac52477";

const EXPECTED_MEMO =
  `relaystream-rights:v1:sha256:${EXPECTED_PROVENANCE_HASH}`;

async function main() {
  const connection = new Connection(
    clusterApiUrl("devnet"),
    "confirmed"
  );

  console.log("\n==============================");
  console.log("RELAYSTREAM RIGHTS");
  console.log("ON-CHAIN PROVENANCE VERIFIER");
  console.log("==============================");
  console.log("NETWORK: DEVNET");
  console.log("FETCHING TRANSACTION...");
  console.log(TRANSACTION_SIGNATURE);

  const transaction = await connection.getTransaction(
    TRANSACTION_SIGNATURE,
    {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    }
  );

  if (!transaction) {
    throw new Error("Transaction was not found on Solana Devnet.");
  }

  console.log("\nTRANSACTION: FOUND");

  const logMessages = transaction.meta?.logMessages ?? [];

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

  const hashFound = memoLog.includes(
    EXPECTED_PROVENANCE_HASH
  );

  console.log("\n==============================");
  console.log("PROVENANCE VERIFICATION");
  console.log("==============================");
  console.log("EXPECTED HASH:");
  console.log(EXPECTED_PROVENANCE_HASH);

  console.log("\nEXPECTED MEMO:");
  console.log(EXPECTED_MEMO);

  if (!hashFound) {
    console.log("\nSTATUS: VERIFICATION FAILED");
    throw new Error(
      "On-chain provenance hash does not match expected hash."
    );
  }

  console.log("\nSTATUS: VERIFIED");
  console.log("HASH MATCH: TRUE");
  console.log(
    "RESULT: On-chain provenance proof matches the expected RelayStream Rights provenance hash."
  );
}

main().catch((error) => {
  console.error("\nVERIFICATION FAILED");
  console.error(error);
  process.exit(1);
});