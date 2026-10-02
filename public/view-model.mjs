// Presentation checks only. Authorization, hashing, chain verification and allocation stay on the server.
export const STAGES = Object.freeze([
  ["AUTHORIZED", "AUTHORIZED"], ["PROCESSING", "PROCESSING"], ["OUTPUT_VERIFIED", "OUTPUT VERIFIED"],
  ["PROVENANCE_V2", "PROVENANCE v2"], ["SOLANA_VERIFIED", "SOLANA VERIFIED"], ["ROYALTY_ALLOCATED", "ROYALTY ALLOCATED"],
]);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const decimalMinor = value => {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value) || value.length > 17) return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
};
const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const equal = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const keys = Object.keys(a).sort(), other = Object.keys(b).sort();
  return keys.length === other.length && keys.every((key, i) => key === other[i] && equal(a[key], b[key]));
};
function base58Bytes(value, length) {
  if (typeof value !== "string" || value.length > 90 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return false;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const character of value) number = number * 58n + BigInt(alphabet.indexOf(character));
  let bytes = 0;
  while (number) { bytes++; number >>= 8n; }
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === length;
}

export function denyEvidence(run, assetId) {
  const r = run?.result, a = r?.authorization, c = run?.calls;
  return Boolean(run?.state === "complete" && r?.status === "blocked" && r.reasonCode === "PERMISSION_DENIED"
    && r.action === "aiTraining" && r.assetId === assetId && a?.assetId === assetId && a.action === "aiTraining"
    && a.decision === "deny" && a.authorized === false && a.policyIntegrityValid === true
    && hash(a.registeredPolicyHash) && a.registeredPolicyHash === a.currentPolicyHash
    && r.processorInvoked === false && r.processingCompleted === false && r.executionId === null && r.processingResult === null
    && r.provenanceCreated === false && r.provenance === null && r.proof === null
    && r.solanaAnchored === false && r.solanaSignature === null && r.anchor === null
    && r.royaltyEventCreated === false && r.royaltyAllocated === false && r.royalty === null && r.fundsTransferred === false
    && run.outputMediaUrl === null && c?.processor === 0 && c.provenance === 0 && c.anchor === 0 && c.verifyAnchor === 0
    && c.solana === 0 && c.royalty === 0);
}

function authorized(r) {
  const a = r?.authorization;
  return Boolean(r?.action === "transcoding" && a?.action === r.action && a.assetId === r.assetId && a.authorized === true
    && a.decision === "allow" && a.policyIntegrityValid === true && hash(a.sourceContentHash)
    && hash(a.registeredPolicyHash) && a.registeredPolicyHash === a.currentPolicyHash && r.fundsTransferred === false);
}
function processed(r) {
  const p = r?.processingResult, m = p?.processing;
  return Boolean(authorized(r) && (r.status === "processed" || (r.status === "failed" && ["provenance", "anchor", "royalty"].includes(r.stage)))
    && r.processorInvoked === true && r.processingCompleted === true && typeof r.executionId === "string"
    && p?.executionId === r.executionId && p.hashAlgorithm === "sha256" && p.sourceContentHash === r.authorization.sourceContentHash
    && hash(p.outputContentHash) && positive(p.outputSizeBytes) && m?.tool === "ffmpeg" && m.outputFormat === "mp4"
    && m.videoCodec === "h264" && (m.audioCodec === "aac" || m.audioCodec === null)
    && positive(m.width) && positive(m.height) && positive(m.durationMs)
    && iso(m.startedAt) && iso(m.completedAt) && m.startedAt <= m.completedAt);
}
export function provenanceVerified(r) {
  const p = r?.provenance, a = r?.authorization, out = r?.processingResult;
  return Boolean(processed(r) && (r.status === "processed" || (r.status === "failed" && ["anchor", "royalty"].includes(r.stage)))
    && r.provenanceCreated === true && p?.schemaVersion === 2 && r.proof?.hashAlgorithm === "sha256"
    && hash(r.proof.provenanceHash) && equal(r.proof.record, p) && p.executionId === r.executionId
    && p.provenanceId === `prov-${r.executionId}` && p.sourceAssetId === r.assetId && p.derivedAssetId === r.derivedAssetId
    && p.action === r.action && p.policyId === a.policyId && p.policyHash === a.registeredPolicyHash && p.owner === a.owner
    && p.sourceContentHash === a.sourceContentHash && p.outputContentHash === out.outputContentHash && p.outputSizeBytes === out.outputSizeBytes
    && equal(p.processing, out.processing) && p.createdAt === out.processing.completedAt);
}
export function anchorVerified(r) {
  const a = r?.anchor, v = a?.verification, s = a?.submission;
  const memo = `relaystream-rights:v2:sha256:${r?.proof?.provenanceHash}`;
  return Boolean(provenanceVerified(r) && (r.status === "processed" || (r.status === "failed" && r.stage === "royalty"))
    && r.solanaAnchored === true && base58Bytes(r.solanaSignature, 64)
    && a?.state === "verified" && a.stage === "verification" && a.transactionStatus === "confirmed"
    && a.signature === r.solanaSignature && base58Bytes(a.expectedAuthority, 32)
    && s?.confirmed === true && s.signature === r.solanaSignature && s.provenanceHash === r.proof.provenanceHash
    && s.memo === memo && s.signer === a.expectedAuthority && s.network === "devnet"
    && v?.verified === true && v.transactionSucceeded === true && v.signature === r.solanaSignature
    && v.computedHash === r.proof.provenanceHash && v.expectedMemo === memo && v.onChainMemo === memo
    && v.expectedAuthority === a.expectedAuthority && v.verifiedAuthority === a.expectedAuthority
    && v.network === "devnet" && v.rpcEndpoint === "https://api.devnet.solana.com"
    && v.genesisHash === "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" && positive(v.slot));
}
export function explorerLink(r) {
  return anchorVerified(r) ? `https://explorer.solana.com/tx/${encodeURIComponent(r.solanaSignature)}?cluster=devnet` : null;
}

export function allocationView(r) {
  const event = r?.royalty?.event;
  if (!anchorVerified(r) || r.status !== "processed" || r.royaltyEventCreated !== true || r.royaltyAllocated !== true || !event
    || event.schemaVersion !== 2 || event.executionId !== r.executionId || event.assetId !== r.assetId
    || event.derivedAssetId !== r.derivedAssetId || event.action !== r.action || event.authorized !== true
    || event.provenanceId !== r.provenance.provenanceId || event.provenanceHash !== r.proof.provenanceHash
    || event.solanaSignature !== r.solanaSignature || event.verifiedAuthority !== r.anchor.verification.verifiedAuthority
    || event.currency !== "USD-DEMO" || event.minorUnitScale !== 100 || event.allocationOnly !== true || event.fundsTransferred !== false
    || !positive(event.usageAmountMinorUnits) || event.totalAllocatedMinorUnits !== event.usageAmountMinorUnits
    || event.totalAllocated !== event.usageAmount || !/^(0|[1-9]\d*)\.\d{2}$/.test(event.usageAmount)
    || decimalMinor(event.usageAmount) !== BigInt(event.usageAmountMinorUnits)
    || event.remainderMethod !== "largest-remainder-recipient-order" || !hash(r.royalty.proof?.royaltyEventHash)
    || r.royalty.proof.hashAlgorithm !== "sha256" || !Array.isArray(event.allocations) || event.allocations.length !== 4) return null;
  const roles = ["creator", "rightsholder", "distributor", "infrastructure"];
  if (!event.allocations.every((row, i) => row.role === roles[i] && typeof row.wallet === "string" && row.wallet.length > 0
    && typeof row.percentage === "number" && Number.isFinite(row.percentage) && row.percentage > 0 && row.percentage <= 100
    && positive(row.basisPoints) && Number.isSafeInteger(row.amountMinorUnits) && row.amountMinorUnits >= 0
    && typeof row.amount === "string" && /^(0|[1-9]\d*)\.\d{2}$/.test(row.amount)
    && decimalMinor(row.amount) === BigInt(row.amountMinorUnits) && decimalMinor(String(row.percentage)) === BigInt(row.basisPoints))) return null;
  // Consistency validation only. Never derive an allocation amount or percentage for display.
  if (event.allocations.reduce((sum, row) => sum + BigInt(row.amountMinorUnits), 0n) !== BigInt(event.totalAllocatedMinorUnits)) return null;
  if (event.allocations.reduce((sum, row) => sum + row.basisPoints, 0) !== 10000) return null;
  return { rows: event.allocations.map(row => ({ ...row })), currency: event.currency, requested: event.usageAmount,
    total: event.totalAllocated, requestedMinorUnits: event.usageAmountMinorUnits, totalMinorUnits: event.totalAllocatedMinorUnits,
    eventId: event.royaltyEventId, remainderMethod: event.remainderMethod };
}

function history(run) {
  if (!Array.isArray(run?.milestones)) return null;
  let previous = "";
  for (let i = 0; i < run.milestones.length; i++) {
    const e = run.milestones[i];
    if (e?.milestone !== STAGES[i]?.[0] || e.sequence !== i + 1 || !iso(e.observedAt) || e.observedAt < previous) return null;
    previous = e.observedAt;
  }
  return run.milestones;
}
export function executionView(run) {
  const r = run?.result, milestones = history(run), terminal = run?.state !== "running";
  const uncertain = run?.state === "unknown" || r?.anchor?.transactionStatus === "unknown";
  const p = processed(r), proof = provenanceVerified(r);
  const chain = run?.state === "complete" && !uncertain && anchorVerified(r), allocation = chain ? allocationView(r) : null;
  const gates = [authorized(r), p, p, proof, chain, Boolean(allocation)];
  const failure = r?.status === "failed" ? ({ request_validation: 1, source_validation: 1, processing: 1, provenance: 3, anchor: 4, royalty: 5 }[r.stage] ?? 0)
    : r?.status === "blocked" ? 0 : null;
  const steps = STAGES.map(([key, label], i) => {
    const event = milestones?.[i];
    let state = "pending", detail = "Pending";
    if (event) {
      state = terminal ? gates[i] ? "complete" : "unverified" : "observed";
      detail = terminal ? gates[i] ? "Verified receipt" : "Receipt did not verify" : "Observed by backend";
    }
    if (i === failure) { state = "failed"; detail = "Failed at this stage"; }
    if (failure !== null && i > failure) { state = "unreached"; detail = "Not reached"; }
    if (!terminal && milestones?.length === i + 1 && i === 1) { state = "active"; detail = "Media processor running"; }
    return { key, label, state, detail, observedAt: event?.observedAt ?? null };
  });
  const calls = run?.calls;
  const proofCalls = Boolean(calls?.processor === 1 && calls.provenance === 1);
  const chainCalls = proofCalls && calls.anchor === 1 && calls.verifyAnchor === 1 && calls.solana === 2;
  const allocationCalls = chainCalls && calls.royalty === 1;
  if (terminal && (!milestones || !proofCalls || !chainCalls || !allocationCalls)) {
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].state === "complete" && (!milestones || (i === 1 && calls?.processor !== 1) || (i >= 2 && !proofCalls) || (i >= 4 && !chainCalls) || (i === 5 && !allocationCalls))) {
        steps[i].state = "unverified"; steps[i].detail = "Execution evidence did not match";
      }
    }
  }
  const complete = Boolean(run?.state === "complete" && r?.status === "processed" && milestones?.length === 6 && gates.every(Boolean)
    && calls?.processor === 1 && calls.provenance === 1 && calls.anchor === 1 && calls.verifyAnchor === 1 && calls.solana === 2 && calls.royalty === 1);
  let message = "Submit the authorized transcoding request after the prohibited-action demonstration.";
  if (run) message = complete ? "Verified media proof anchored. Royalty allocation recorded."
    : uncertain ? "Submission state is uncertain. No automatic retry; allocation has not been released."
    : r?.status === "failed" ? `Execution stopped at ${r.stage}. ${r.error?.code ?? "EXECUTION_FAILED"}`
    : r?.status === "blocked" ? "The authorization gate blocked this request."
    : terminal ? "Receipt evidence is incomplete or inconsistent. Verified success is withheld."
    : milestones?.some(e => e.milestone === "PROVENANCE_V2") ? "Waiting for Devnet confirmation and independent verification"
    : milestones?.some(e => e.milestone === "PROCESSING") ? "Processing authorized media and independently verifying output bytes."
    : "Waiting for the shared authorization executor.";
  const validRunId = typeof run?.requestId === "string" && /^[0-9a-f-]{36}$/.test(run.requestId);
  const mediaUrl = milestones?.[3] && proofCalls && p && proof && validRunId && run.outputMediaUrl === `/executions/${run.requestId}/output` ? run.outputMediaUrl : null;
  const evidence = [];
  if (authorized(r)) evidence.push(["Source SHA-256", r.authorization.sourceContentHash]);
  if (p) evidence.push(["Output SHA-256", r.processingResult.outputContentHash]);
  if (proof && milestones?.[3] && proofCalls) evidence.push(["Provenance v2 SHA-256", r.proof.provenanceHash]);
  if (chain && milestones?.[4] && chainCalls) evidence.push(["Verified transaction", r.solanaSignature], ["Verified anchoring authority", r.anchor.verification.verifiedAuthority]);
  return { complete, uncertain, steps, message, evidence, mediaUrl, explorerUrl: chain && milestones?.[4] && chainCalls ? explorerLink(r) : null,
    allocation: milestones?.[5] && allocationCalls ? allocation : null,
    processing: p ? r.processingResult.processing : null, proofDownload: proof && milestones?.[3] && proofCalls ? { provenance: r.provenance, proof: r.proof,
      anchor: r.anchor, royalty: r.royalty, fundsTransferred: r.fundsTransferred } : null };
}
