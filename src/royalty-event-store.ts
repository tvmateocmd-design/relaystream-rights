import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { hashRoyaltyEvent, RoyaltyError, type RoyaltyEvent, type RoyaltyProof, type RoyaltyReceipt } from "./royalties";

export interface RoyaltyEventStore {
  record(event: RoyaltyEvent, proof: RoyaltyProof): Promise<RoyaltyReceipt>;
}

function immutableReceipt(event: RoyaltyEvent, proof: RoyaltyProof, created: boolean): RoyaltyReceipt {
  const copy = structuredClone(event);
  for (const allocation of copy.allocations) Object.freeze(allocation);
  Object.freeze(copy.allocations);
  return Object.freeze({ event: Object.freeze(copy), proof: Object.freeze({ ...proof }), created });
}
function validate(event: RoyaltyEvent, proof: RoyaltyProof): void {
  if (event.schemaVersion !== 2 || !event.executionId || event.fundsTransferred !== false || event.allocationOnly !== true
    || proof.hashAlgorithm !== "sha256" || hashRoyaltyEvent(event).royaltyEventHash !== proof.royaltyEventHash) {
    throw new RoyaltyError("ROYALTY_STORE_FAILED", "Invalid royalty ledger record.");
  }
}
function reused(existing: RoyaltyReceipt, event: RoyaltyEvent): RoyaltyReceipt {
  validate(existing.event, existing.proof);
  // A replay proposes a new creation time. Compare every economic/verification field
  // with the original time, then return the original immutable event and full proof.
  const allocationHash = hashRoyaltyEvent({ ...event, createdAt: existing.event.createdAt }).royaltyEventHash;
  if (existing.event.executionId !== event.executionId || existing.proof.royaltyEventHash !== allocationHash) {
    throw new RoyaltyError("IDEMPOTENCY_CONFLICT", "This execution already has a different allocation; the existing event was preserved.");
  }
  return immutableReceipt(existing.event, existing.proof, false);
}

export class InMemoryRoyaltyEventStore implements RoyaltyEventStore {
  private readonly events = new Map<string, RoyaltyReceipt>();
  get size(): number { return this.events.size; }
  async record(event: RoyaltyEvent, proof: RoyaltyProof): Promise<RoyaltyReceipt> {
    validate(event, proof);
    const previous = this.events.get(event.executionId);
    if (previous) return reused(previous, event);
    const receipt = immutableReceipt(event, proof, true);
    this.events.set(event.executionId, receipt);
    return receipt;
  }
}

export class FileRoyaltyEventStore implements RoyaltyEventStore {
  private readonly directory: string;
  constructor(directory: string) { this.directory = path.resolve(directory); }
  async record(event: RoyaltyEvent, proof: RoyaltyProof): Promise<RoyaltyReceipt> {
    validate(event, proof);
    // Hash the execution identity so identifiers never become filesystem paths.
    const key = createHash("sha256").update(event.executionId).digest("hex");
    const target = path.join(this.directory, `${key}.json`);
    const temporary = path.join(this.directory, `.${key}.${randomUUID()}.tmp`);
    let committed: RoyaltyReceipt | null = null;
    let cleanupWarning: string | undefined;
    try {
      await fs.mkdir(this.directory, { recursive: true });
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(immutableReceipt(event, proof, true)), "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      try {
        // Atomic, exclusive publication of fully written bytes. A concurrent/restarted
        // caller can never overwrite the existing allocation or observe a partial record.
        await fs.link(temporary, target);
        committed = immutableReceipt(event, proof, true);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        committed = reused(JSON.parse(await fs.readFile(target, "utf8")) as RoyaltyReceipt, event);
      }
    } catch (error) {
      if (error instanceof RoyaltyError) throw error;
      throw new RoyaltyError("ROYALTY_STORE_FAILED", error instanceof Error ? error.message : "Cannot persist royalty allocation.");
    } finally {
      try { await fs.unlink(temporary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupWarning = "Temporary ledger file cleanup failed."; }
    }
    // Once published, report the actual allocation even if temporary-file cleanup failed.
    return cleanupWarning ? Object.freeze({ ...committed!, cleanupWarning }) : committed!;
  }
}
