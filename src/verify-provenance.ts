import { PublicKey, type GetVersionedTransactionConfig, type VersionedTransactionResponse } from "@solana/web3.js";
import { createDevnetConnection, DEVNET_ENDPOINT, DEVNET_GENESIS_HASH, MEMO_PROGRAM_ID, provenanceMemo } from "./anchor-provenance";
import { hashProvenanceRecord, type ProvenanceRecord } from "./provenance";

export interface VerificationResult {
  verified: boolean;
  signature: string;
  computedHash: string;
  expectedMemo: string;
  onChainMemo: string | null;
  expectedAuthority: string;
  verifiedAuthority: string | null;
  network: "devnet";
  rpcEndpoint: string;
  genesisHash: string | null;
  transactionSucceeded: boolean;
  slot: number | null;
  reason: string;
}

export interface VerificationConnection {
  readonly rpcEndpoint: string;
  getGenesisHash(): Promise<string>;
  getTransaction(signature: string, config: GetVersionedTransactionConfig): Promise<VersionedTransactionResponse | null>;
}

export async function verifyProvenanceOnChain(
  signature: string,
  record: ProvenanceRecord,
  expectedAuthority: string,
  connection: VerificationConnection = createDevnetConnection(),
): Promise<VerificationResult> {
  // Capture the commitment and trusted authority before network IO. No registry reads.
  const computedHash = hashProvenanceRecord(record);
  const expectedMemo = provenanceMemo(computedHash, record.schemaVersion === 2 ? 2 : 1);
  const schemaVersion = record.schemaVersion;
  const result: VerificationResult = {
    verified: false, signature, computedHash, expectedMemo, onChainMemo: null,
    expectedAuthority, verifiedAuthority: null, network: "devnet", rpcEndpoint: connection.rpcEndpoint,
    genesisHash: null, transactionSucceeded: false, slot: null, reason: "Transaction not verified.",
  };
  const fail = (reason: string): VerificationResult => ({ ...result, reason });
  try {
    const authority = new PublicKey(expectedAuthority);
    if (connection.rpcEndpoint !== DEVNET_ENDPOINT) return fail("Unexpected RPC endpoint; configured Devnet connection required.");
    result.genesisHash = await connection.getGenesisHash();
    if (result.genesisHash !== DEVNET_GENESIS_HASH) return fail("RPC genesis hash is not Solana Devnet.");
    const transaction = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!transaction) return fail("Transaction not found at confirmed commitment on Devnet.");
    result.slot = transaction.slot;
    if (transaction.transaction.signatures[0] !== signature) return fail("Fetched transaction signature differs from requested signature.");
    if (!transaction.meta || transaction.meta.err !== null) return fail("Transaction failed or success metadata is unavailable.");
    result.transactionSucceeded = true;
    const message = transaction.transaction.message;
    const keys = message.version === "legacy" ? message.getAccountKeys()
      : message.getAccountKeys({ accountKeysFromLookups: transaction.meta.loadedAddresses ?? null });
    // The configured service authority must sign the transaction as fee payer.
    if (!keys.get(0)?.equals(authority) || !message.isAccountSigner(0)) return fail("Unexpected anchoring authority.");
    const expectedBytes = Buffer.from(expectedMemo, "utf8");
    for (const instruction of message.compiledInstructions) {
      if (!keys.get(instruction.programIdIndex)?.equals(MEMO_PROGRAM_ID)) continue;
      const payload = Buffer.from(instruction.data);
      result.onChainMemo = payload.toString("utf8");
      if (!payload.equals(expectedBytes)) continue;
      // V2 requires the authority on the Memo itself. Legacy unsigned Memo transactions
      // retain compatibility, but still require their independently supplied trusted fee payer.
      const authoritySignedMemo = instruction.accountKeyIndexes.some(index =>
        keys.get(index)?.equals(authority) && message.isAccountSigner(index));
      if (schemaVersion === 2 && !authoritySignedMemo) continue;
      return { ...result, verified: true, verifiedAuthority: authority.toBase58(), reason: "Exact Memo bytes and expected signing authority verified on confirmed Devnet transaction." };
    }
    return fail("No exact provenance Memo instruction signed by the expected authority.");
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Transaction verification failed.");
  }
}
