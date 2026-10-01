import { PublicKey, Transaction, TransactionInstruction, type VersionedTransactionResponse } from "@solana/web3.js";
import { DEVNET_ENDPOINT, DEVNET_GENESIS_HASH, MEMO_PROGRAM_ID, provenanceMemo } from "./anchor-provenance";
import { verifyProvenanceOnChain, type VerificationConnection } from "./verify-provenance";
import { hashProvenanceRecord } from "./provenance";
import type { ExecutionDependencies } from "./index";

export const TEST_AUTHORITY = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
export const TEST_SIGNATURE = "local-test-signature";

export function transactionFixture(memo: string, authority = TEST_AUTHORITY, memoSigner = true,
  programId = MEMO_PROGRAM_ID): VersionedTransactionResponse {
  const key = new PublicKey(authority);
  const tx = new Transaction({ recentBlockhash: new PublicKey(new Uint8Array(32).fill(8)).toBase58(), feePayer: key });
  tx.add(new TransactionInstruction({
    programId, data: Buffer.from(memo, "utf8"),
    keys: memoSigner ? [{ pubkey: key, isSigner: true, isWritable: false }] : [],
  }));
  return {
    slot: 123, version: "legacy", transaction: { message: tx.compileMessage(), signatures: [TEST_SIGNATURE] },
    meta: { err: null, fee: 5000, preBalances: [], postBalances: [], logMessages: [] },
  };
}

export function connectionFixture(transaction: VersionedTransactionResponse | null): VerificationConnection {
  return { rpcEndpoint: DEVNET_ENDPOINT, getGenesisHash: async () => DEVNET_GENESIS_HASH, getTransaction: async () => transaction };
}

// Explicitly injected in local tests. No signer file reads, network requests, or real submissions.
export function localAnchorDependencies(): Pick<ExecutionDependencies, "anchor" | "getAuthority" | "verifyAnchor"> {
  return {
    getAuthority: () => TEST_AUTHORITY,
    anchor: async (hash, authority = TEST_AUTHORITY, version = 2) => ({
      signature: TEST_SIGNATURE, provenanceHash: hash, memo: provenanceMemo(hash, version),
      signer: authority, network: "devnet", confirmed: true,
    }),
    verifyAnchor: async (signature, record, authority) => verifyProvenanceOnChain(signature, record, authority,
      connectionFixture(transactionFixture(provenanceMemo(hashProvenanceRecord(record), record.schemaVersion === 2 ? 2 : 1)))),
  };
}
