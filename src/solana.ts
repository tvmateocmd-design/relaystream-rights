import {
  Connection,
  clusterApiUrl,
} from "@solana/web3.js";

export const connection = new Connection(
  clusterApiUrl("devnet"),
  "confirmed"
);

export async function testSolanaConnection() {
  console.log("\n==============================");
  console.log("SOLANA DEVNET");
  console.log("==============================");

  const version = await connection.getVersion();
  const slot = await connection.getSlot();

  console.log("STATUS: CONNECTED");
  console.log(`RPC: ${clusterApiUrl("devnet")}`);
  console.log(`SOLANA CORE: ${version["solana-core"]}`);
  console.log(`CURRENT SLOT: ${slot}`);
}

testSolanaConnection().catch((error) => {
  console.error("SOLANA CONNECTION FAILED");
  console.error(error);
  process.exit(1);
});