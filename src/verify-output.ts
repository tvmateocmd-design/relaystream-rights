import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

export interface OutputCommitment {
  readonly outputContentHash: string;
  readonly outputSizeBytes: number;
}

export interface OutputVerification {
  verified: boolean;
  expectedHash: string;
  computedHash: string | null;
  expectedSizeBytes: number;
  actualSizeBytes: number | null;
  reason: string;
}

/** Reads file bytes independently of the processor; also checks committed size. */
export async function verifyOutputContent(
  filePath: string,
  commitment: OutputCommitment,
): Promise<OutputVerification> {
  const expectedHash = commitment.outputContentHash;
  const expectedSizeBytes = commitment.outputSizeBytes;
  const result = {
    verified: false, expectedHash, expectedSizeBytes,
    computedHash: null as string | null, actualSizeBytes: null as number | null,
    reason: "",
  };
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || !Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes <= 0) {
    return { ...result, reason: "Invalid output commitment." };
  }
  try {
    const file = await open(filePath, "r");
    try {
      if (!(await file.stat()).isFile()) return { ...result, reason: "Output must be a regular file." };
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        const bytes = chunk as Buffer;
        hash.update(bytes);
        size += bytes.length;
      }
      const computedHash = hash.digest("hex");
      const verified = computedHash === expectedHash && size === expectedSizeBytes;
      return {
        ...result, verified, computedHash, actualSizeBytes: size,
        reason: verified ? "Output bytes and size match the commitment." : "Output bytes or size do not match the commitment.",
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    return { ...result, reason: error instanceof Error ? error.message : "Cannot read output media." };
  }
}
