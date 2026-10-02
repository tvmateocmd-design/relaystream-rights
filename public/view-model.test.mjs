import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { before, after, test } from "node:test";
import { createApiServer } from "../src/api.ts";
import { TEST_AUTHORITY, transactionFixture, connectionFixture } from "../src/anchor-test-support.ts";
import { provenanceMemo } from "../src/anchor-provenance.ts";
import { verifyProvenanceOnChain } from "../src/verify-provenance.ts";
import { hashProvenanceRecord } from "../src/provenance.ts";
import { transcodeMedia } from "../src/transcode-media.ts";
import { InMemoryRoyaltyEventStore } from "../src/royalty-event-store.ts";
import { STAGES, allocationView, anchorVerified, denyEvidence, executionView, explorerLink } from "./view-model.mjs";

let root, api, base, denied, allowed;
const signature = "1".repeat(64); // Deterministic local transaction fixture; never a submitted Devnet transaction.
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relaystream-interface-"));
  await fs.mkdir(path.join(root, "test-media")); await fs.mkdir(path.join(root, "public"));
  await fs.copyFile(path.resolve("test-media/relaystream-demo.mp4"), path.join(root, "test-media/relaystream-demo.mp4"));
  for (const file of ["index.html", "styles.css", "app.mjs", "view-model.mjs"]) await fs.copyFile(path.resolve("public", file), path.join(root, "public", file));
  const log = console.log; console.log = () => {};
  try {
    api = createApiServer({ demo: true, workspaceRoot: root, dependencies: {
      processor: transcodeMedia, royaltyStore: new InMemoryRoyaltyEventStore(), getAuthority: () => TEST_AUTHORITY,
      anchor: async (hash, authority, version) => ({ signature, provenanceHash: hash, memo: provenanceMemo(hash, version), signer: authority, network: "devnet", confirmed: true }),
      verifyAnchor: async (sig, record, authority) => {
        const tx = transactionFixture(provenanceMemo(hashProvenanceRecord(record), 2)); tx.transaction.signatures[0] = sig;
        return verifyProvenanceOnChain(sig, record, authority, connectionFixture(tx));
      },
    } });
  } finally { console.log = log; }
  api.server.listen(0, "127.0.0.1"); await once(api.server, "listening");
  base = `http://127.0.0.1:${api.server.address().port}`;
  for (const action of ["aiTraining", "transcoding"]) {
    const requestId = randomUUID();
    const response = await fetch(base + "/actions/execute?async=1", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, assetId: "relaystream-demo-001", derivedAssetId: `derived-${requestId}`, action, usageAmount: "100.00" }) });
    assert.equal(response.status, 202); await api.executions.wait(requestId);
    const run = await fetch(`${base}/executions/${requestId}`).then(r => r.json());
    if (action === "aiTraining") denied = run; else allowed = run;
  }
});
after(async () => {
  if (api) { api.server.closeAllConnections(); await new Promise(resolve => api.server.close(resolve)); }
  if (root) { const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root)); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative)); await fs.rm(root, { recursive: true, force: true }); }
});

test("canonical real HTTP DENY unlocks step two only with every required zero-call/absence check", () => {
  assert.equal(denyEvidence(denied, "relaystream-demo-001"), true);
  assert.equal(denyEvidence(denied, "another-asset"), false);
  for (const mutate of [r => { r.calls.processor = 1; }, r => { r.calls.provenance = 1; }, r => { r.calls.solana = 1; },
    r => { r.calls.royalty = 1; }, r => { r.result.provenance = {}; }, r => { r.result.authorization.policyIntegrityValid = false; },
    r => { r.result.reasonCode = "POLICY_INTEGRITY_FAILED"; }, r => { r.state = "running"; }, r => { delete r.calls; }]) {
    const run = structuredClone(denied); mutate(run); assert.equal(denyEvidence(run, "relaystream-demo-001"), false);
  }
});

test("real processed output plus injected exact chain receipt produces all six completed milestones", () => {
  const view = executionView(allowed);
  assert.equal(view.complete, true); assert.deepEqual(view.steps.map(s => s.label), STAGES.map(s => s[1]));
  assert.ok(view.steps.every(s => s.state === "complete")); assert.equal(view.mediaUrl, allowed.outputMediaUrl);
  assert.equal(view.evidence.find(([label]) => label === "Output SHA-256")[1], allowed.result.provenance.outputContentHash);
});

test("live observations never manufacture terminal verified success, allocation or Explorer data", () => {
  for (let count = 0; count <= 6; count++) {
    const run = { ...allowed, state: "running", result: null, milestones: allowed.milestones.slice(0, count) };
    const view = executionView(run); assert.equal(view.complete, false); assert.equal(view.explorerUrl, null);
    assert.equal(view.allocation, null); assert.ok(view.steps.every(s => s.state !== "complete"));
    assert.ok(view.steps.slice(count).every(s => s.state === "pending"));
    if (count === 2) assert.equal(view.steps[1].state, "active");
    if (count === 4) assert.match(view.message, /Waiting for Devnet confirmation and independent verification/);
  }
});

test("contradictory, incomplete and malformed terminal receipts cannot render verified success", async t => {
  const cases = {
    "authorization denied": r => { r.result.authorization.authorized = false; },
    "policy mismatch": r => { r.result.authorization.currentPolicyHash = "0".repeat(64); },
    "no processor invocation": r => { r.result.processorInvoked = false; },
    "processing incomplete": r => { r.result.processingCompleted = false; },
    "missing output hash": r => { delete r.result.processingResult.outputContentHash; },
    "output hash mismatch": r => { r.result.processingResult.outputContentHash = "0".repeat(64); },
    "metadata mismatch": r => { r.result.processingResult.processing.width = 999; },
    "missing provenance": r => { r.result.provenance = null; },
    "proof record mismatch": r => { r.result.proof.record.owner = "Changed"; },
    "wrong execution ID": r => { r.result.executionId = "another-execution"; },
    "provenance not created": r => { r.result.provenanceCreated = false; },
    "anchor false": r => { r.result.solanaAnchored = false; },
    "missing independent verification": r => { r.result.anchor.verification = null; },
    "failed independent verification": r => { r.result.anchor.verification.verified = false; },
    "wrong authority": r => { r.result.anchor.verification.verifiedAuthority = "wrong"; },
    "wrong hash": r => { r.result.anchor.verification.computedHash = "0".repeat(64); },
    "unknown submission": r => { r.result.anchor.transactionStatus = "unknown"; },
    "royalty flag false": r => { r.result.royaltyAllocated = false; },
    "royalty binding mismatch": r => { r.result.royalty.event.executionId = "wrong"; },
    "allocation total mismatch": r => { r.result.royalty.event.totalAllocatedMinorUnits = 9999; },
    "row conservation mismatch": r => { r.result.royalty.event.allocations[0].amountMinorUnits++; },
    "display amount mismatch": r => { r.result.royalty.event.allocations[0].amount = "99.99"; },
    "percentage/basis points mismatch": r => { r.result.royalty.event.allocations[0].percentage = 99; },
    "wrong currency": r => { r.result.royalty.event.currency = "USDC"; },
    "funds transferred": r => { r.result.fundsTransferred = true; },
    "missing counts": r => { r.calls = null; },
    "false chain invocation counts": r => { r.calls.anchor = 0; },
    "missing milestone": r => { r.milestones.pop(); },
    "out of order milestones": r => { [r.milestones[0], r.milestones[1]] = [r.milestones[1], r.milestones[0]]; },
    "invalid milestone timestamp": r => { r.milestones[0].observedAt = "not-a-date"; },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, () => {
    const run = structuredClone(allowed); mutate(run); assert.equal(executionView(run).complete, false);
  });
  for (const run of [null, {}, { state: "complete", result: {} }, { state: "unknown", milestones: [], result: null }]) assert.equal(executionView(run).complete, false);
});

test("Explorer requires the exact successful Devnet signature, commitment, authority, Memo and network", async t => {
  assert.equal(anchorVerified(allowed.result), true);
  assert.equal(explorerLink(allowed.result), `https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  const mutations = {
    "transaction failed": r => { r.anchor.verification.transactionSucceeded = false; },
    "wrong signature": r => { r.anchor.verification.signature = "2".repeat(64); },
    "partial Memo": r => { r.anchor.verification.onChainMemo = r.proof.provenanceHash.slice(0, 32); },
    "substring Memo": r => { r.anchor.verification.onChainMemo += "suffix"; },
    "wrong expected authority": r => { r.anchor.expectedAuthority = "wrong"; },
    "wrong network": r => { r.anchor.verification.network = "mainnet"; },
    "wrong genesis": r => { r.anchor.verification.genesisHash = "wrong"; },
    "wrong RPC": r => { r.anchor.verification.rpcEndpoint = "https://evil.example"; },
    "unconfirmed": r => { r.anchor.submission.confirmed = false; },
    "malicious signature": r => { r.solanaSignature = "javascript:alert(1)"; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => {
    const receipt = structuredClone(allowed.result); mutate(receipt); assert.equal(explorerLink(receipt), null);
  });
});

test("failed/downstream-unreached stages never turn green even when contradictory success milestones are supplied", () => {
  for (const [stage, index] of [["source_validation", 1], ["processing", 1], ["provenance", 3], ["anchor", 4], ["royalty", 5]]) {
    const run = structuredClone(allowed); run.result.status = "failed"; run.result.stage = stage; run.result.error = { code: "TEST_FAILURE" };
    const view = executionView(run); assert.equal(view.complete, false); assert.equal(view.steps[index].state, "failed");
    assert.ok(view.steps.slice(index + 1).every(s => s.state === "unreached")); assert.equal(view.allocation, null);
    if (stage !== "royalty") assert.equal(view.explorerUrl, null);
  }
});

test("allocation view returns backend rows and totals unchanged, including returned decimal strings", () => {
  const allocation = allocationView(allowed.result);
  assert.deepEqual(allocation.rows, allowed.result.royalty.event.allocations);
  assert.deepEqual(allocation.rows.map(r => r.amount), ["60.00", "20.00", "10.00", "10.00"]);
  assert.deepEqual(allocation.rows.map(r => r.percentage), [60, 20, 10, 10]);
  assert.deepEqual(allocation.rows.map(r => r.amountMinorUnits), [6000, 2000, 1000, 1000]);
  assert.equal(allocation.totalMinorUnits, allowed.result.royalty.event.totalAllocatedMinorUnits);
  assert.equal(allocation.currency, "USD-DEMO");
  allocation.rows[0].amount = "changed"; assert.equal(allowed.result.royalty.event.allocations[0].amount, "60.00");
});

test("untrusted output URLs, absent receipts and unknown submissions are not presented as successful processing", () => {
  const run = structuredClone(allowed); run.outputMediaUrl = "file:///private/signer.json"; assert.equal(executionView(run).mediaUrl, null);
  run.outputMediaUrl = "https://evil.example/video"; assert.equal(executionView(run).mediaUrl, null);
  run.state = "unknown"; run.result = null; assert.equal(executionView(run).uncertain, true); assert.equal(executionView(run).mediaUrl, null);
});

test("verified chain labels and proof download are withheld when observation or invocation evidence contradicts the receipt", () => {
  for (const mutate of [r => { r.calls = null; }, r => { r.calls.anchor = 0; }, r => { r.milestones = []; }, r => { r.state = "unknown"; }]) {
    const run = structuredClone(allowed); mutate(run);
    const view = executionView(run);
    assert.equal(view.explorerUrl, null);
    assert.equal(view.allocation, null);
    assert.ok(!view.evidence.some(([label]) => label.startsWith("Verified")));
    if (!run.calls || !run.milestones.length) assert.equal(view.proofDownload, null);
  }
});

test("served HTML/CSS/modules use local allowlisted assets, safe DOM rendering and accessible controls", async () => {
  const html = await fetch(base + "/").then(r => { assert.equal(r.status, 200); return r.text(); });
  const app = await fetch(base + "/app.mjs").then(r => r.text());
  assert.match(html, /name="viewport"/); assert.match(html, /class="skip-link"/); assert.match(html, /role="status"/);
  assert.match(html, /Request AI Training/); assert.match(html, /Transcode Authorized Media/);
  assert.match(html, /FUNDS TRANSFERRED: NO — ALLOCATION ONLY/); assert.match(html, /USD-DEMO/);
  assert.ok(!/<(?:script|link)[^>]+(?:src|href)="https?:/.test(html));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|eval\(/.test(app));
  const renderer = app.slice(app.indexOf("function renderAllocation"), app.indexOf("function renderAllow"));
  assert.match(renderer, /row\.amount/); assert.match(renderer, /row\.percentage/); assert.ok(!/toFixed|Math\./.test(renderer));
  assert.equal((await fetch(base + "/view-model.test.mjs")).status, 404);
});

test("narrow-layout structure stacks cards and media and permits long evidence to wrap", async () => {
  const css = await fetch(base + "/styles.css").then(r => r.text());
  assert.match(css, /@media\(max-width:720px\)/);
  assert.match(css, /\.asset-grid,\.demo-grid,\.results-grid,\.media-grid\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(css, /\.site-header\{padding:20px;flex-wrap:wrap/);
  assert.match(css, /overflow-wrap:anywhere/); assert.match(css, /:focus-visible/);
  assert.match(css, /\.table-scroll\{[^}]*overflow-x:auto/);
});
