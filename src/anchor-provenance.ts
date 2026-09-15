import fs from "node:fs";
import path from "node:path";

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

const PROVENANCE_HASH =
  "5b53dc6c3a29bd694d0e75f91e7658fe2bbffab72e66acc0d32f41d00ac52477";

async function main() {
  const connection = new Connection(
    clusterApiUrl("devnet"),
    "confirmed"
  );

  const keypairPath = path.join(
    process.env.USERPROFILE!,
    ".relaystream",
    "devnet-keypair.json"
  );

  const secretKey = JSON.parse(
    fs.readFileSync(keypairPath, "utf8")
  );

  const signer = Keypair.fromSecretKey(
    Uint8Array.from(secretKey)
  );

  const memo = `relaystream-rights:v1:sha256:${PROVENANCE_HASH}`;

  const instruction = new TransactionInstruction({
    keys: [],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(memo, "utf8"),
  });

  const transaction = new Transaction().add(instruction);

  console.log("\n==============================");
  console.log("RELAYSTREAM RIGHTS");
  console.log("SOLANA PROVENANCE ANCHOR");
  console.log("==============================");
  console.log("NETWORK: DEVNET");
  console.log("SIGNER:", signer.publicKey.toBase58());
  console.log("PROVENANCE HASH:", PROVENANCE_HASH);
  console.log("SUBMITTING...");

  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    [signer],
    {
      commitment: "confirmed",
    }
  );

  console.log("\nSTATUS: CONFIRMED");
  console.log("TRANSACTION SIGNATURE:");
  console.log(signature);

  console.log("\nEXPLORER:");
  console.log(
    `https://explorer.solana.com/tx/${signature}?cluster=devnet`
  );
}

main().catch((error) => {
  console.error("\nANCHOR FAILED");
  console.error(error);
  process.exit(1);
});