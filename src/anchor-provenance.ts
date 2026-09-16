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

export interface AnchorResult {
  signature: string;
  provenanceHash: string;
  memo: string;
  signer: string;
}

function loadDevnetSigner(): Keypair {
  const keypairPath = path.join(
    process.env.USERPROFILE!,
    ".relaystream",
    "devnet-keypair.json"
  );

  const secretKey = JSON.parse(
    fs.readFileSync(keypairPath, "utf8")
  );

  return Keypair.fromSecretKey(
    Uint8Array.from(secretKey)
  );
}

export async function anchorProvenanceProof(
  provenanceHash: string
): Promise<AnchorResult> {
  const connection = new Connection(
    clusterApiUrl("devnet"),
    "confirmed"
  );

  const signer = loadDevnetSigner();

  const memo =
    `relaystream-rights:v1:sha256:${provenanceHash}`;

  const instruction = new TransactionInstruction({
    keys: [],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(memo, "utf8"),
  });

  const transaction = new Transaction().add(instruction);

  console.log("\n==============================");
  console.log("SOLANA PROVENANCE ANCHOR");
  console.log("==============================");
  console.log("NETWORK: DEVNET");
  console.log("SIGNER:", signer.publicKey.toBase58());
  console.log("PROVENANCE HASH:", provenanceHash);
  console.log("SUBMITTING...");

  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    [signer],
    {
      commitment: "confirmed",
    }
  );

  console.log("\nANCHOR: CONFIRMED");
  console.log("TRANSACTION SIGNATURE:");
  console.log(signature);

  return {
    signature,
    provenanceHash,
    memo,
    signer: signer.publicKey.toBase58(),
  };
}