import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, clusterApiUrl } from "@solana/web3.js";

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const DEVNET_ENDPOINT = clusterApiUrl("devnet");
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export function createDevnetConnection(): Connection {
  return new Connection(DEVNET_ENDPOINT, {
    commitment: "confirmed", disableRetryOnRateLimit: true,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
  });
}

export function provenanceMemo(hash: string, version: 1 | 2 = 2): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("A complete lowercase SHA-256 is required.");
  return `relaystream-rights:v${version}:sha256:${hash}`;
}

export interface AnchorResult {
  signature: string;
  provenanceHash: string;
  memo: string;
  signer: string;
  network: "devnet";
  confirmed: true;
}

export class AnchorError extends Error {
  constructor(
    message: string,
    readonly stage: "preflight" | "submission" | "confirmation",
    readonly signature: string | null,
    readonly transactionStatus: "not_submitted" | "unknown" | "failed",
  ) { super(message); this.name = "AnchorError"; }
}

function loadDevnetSigner(): Keypair {
  if (!process.env.USERPROFILE) throw new Error("USERPROFILE is required to locate the configured Devnet signer.");
  const keypairPath = path.join(process.env.USERPROFILE, ".relaystream", "devnet-keypair.json");
  const secretKey = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

export function getDevnetAuthority(): string {
  return loadDevnetSigner().publicKey.toBase58();
}

export async function anchorProvenanceProof(
  provenanceHash: string,
  expectedAuthority: string = getDevnetAuthority(),
  version: 1 | 2 = 2,
): Promise<AnchorResult> {
  let stage: AnchorError["stage"] = "preflight";
  let signature: string | null = null;
  try {
    const memo = provenanceMemo(provenanceHash, version);
    const signer = loadDevnetSigner();
    if (signer.publicKey.toBase58() !== expectedAuthority) throw new Error("Configured signer changed before anchoring.");
    const connection = createDevnetConnection();
    if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) throw new Error("RPC is not Solana Devnet.");
    const blockhash = await connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({ ...blockhash, feePayer: signer.publicKey }).add(new TransactionInstruction({
      keys: [{ pubkey: signer.publicKey, isSigner: true, isWritable: false }],
      programId: MEMO_PROGRAM_ID, data: Buffer.from(memo, "utf8"),
    }));
    stage = "submission";
    // Submit once. A transport error may leave submission uncertain; never blindly resubmit.
    signature = await connection.sendTransaction(transaction, [signer], { preflightCommitment: "confirmed", maxRetries: 2 });
    stage = "confirmation";
    const confirmation = await connection.confirmTransaction({
      ...blockhash, signature, abortSignal: AbortSignal.timeout(45_000),
    }, "confirmed");
    if (confirmation.value.err !== null) {
      throw new AnchorError(`Solana transaction failed: ${JSON.stringify(confirmation.value.err)}`, stage, signature, "failed");
    }
    return { signature, provenanceHash, memo, signer: expectedAuthority, network: "devnet", confirmed: true };
  } catch (error) {
    if (error instanceof AnchorError) throw error;
    throw new AnchorError(error instanceof Error ? error.message : "Solana anchoring failed.", stage, signature,
      stage === "preflight" ? "not_submitted" : "unknown");
  }
}
