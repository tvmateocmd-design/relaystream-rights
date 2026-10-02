import { denyEvidence, executionView } from "/view-model.mjs";

const ASSET_ID = "relaystream-demo-001";
const SESSION_KEY = "relaystream-rights-demo-session-v1";
const byId = id => document.getElementById(id);
const text = (id, value) => { byId(id).textContent = value; };
const element = (name, content, className) => {
  const node = document.createElement(name); if (content !== undefined) node.textContent = String(content);
  if (className) node.className = className; return node;
};
let asset = null, denyRun = null, allowRun = null, connected = false, busy = false, transportUncertain = false;
let session = { assetId: ASSET_ID }, view = executionView(null);

function notice(message, error = false) {
  const node = byId("global-message"); node.textContent = message; node.className = error ? "notice error" : "notice"; node.hidden = !message;
}
function connection(online) {
  connected = online; text("connection", online ? "API CONNECTED" : "API UNAVAILABLE");
  byId("connection").className = `connection ${online ? "online" : "error"}`;
}
function controls() {
  byId("deny-button").disabled = !connected || !asset || busy || Boolean(session.denyRequest) || transportUncertain;
  byId("allow-button").disabled = !connected || !denyEvidence(denyRun, ASSET_ID) || busy || Boolean(session.allowRequest) || transportUncertain;
  if (denyEvidence(denyRun, ASSET_ID)) text("allow-lock", session.allowRequest ? "This execution is retained; it will not be submitted again." : "Authorization boundary demonstrated. Ready for real transcoding.");
}
async function api(route, options = {}) {
  const response = await fetch(route, { ...options, signal: AbortSignal.timeout(12000) });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
  connection(true); return body;
}
function remember() {
  // Persist before POST. If storage is unavailable, stop rather than risk losing the request identity.
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}
function restore() {
  const raw = sessionStorage.getItem(SESSION_KEY); if (!raw) return;
  const saved = JSON.parse(raw);
  if (saved.assetId !== ASSET_ID) throw new Error("Saved request belongs to another asset.");
  for (const key of ["denyRequest", "allowRequest"]) {
    const req = saved[key];
    if (req && (!/^[0-9a-f-]{36}$/.test(req.requestId) || req.assetId !== ASSET_ID
      || req.action !== (key === "denyRequest" ? "aiTraining" : "transcoding"))) throw new Error("Saved request is invalid.");
  }
  session = saved;
}
function media(id, url) {
  const node = byId(id);
  if (node.getAttribute("src") !== url) { node.setAttribute("src", url); node.load(); }
}
function renderAsset(value) {
  if (value.assetId !== ASSET_ID || value.sourceMediaUrl !== `/media/${ASSET_ID}/source`
    || !/^[a-f0-9]{64}$/.test(value.sourceContentHash) || !value.policy || !/^[a-f0-9]{64}$/.test(value.policyHash)) throw new Error("Registered asset response is incomplete.");
  asset = value;
  text("asset-title", value.title); text("asset-id", value.assetId); text("publisher", value.owner); text("policy-id", value.policy.policyId);
  media("source-player", value.sourceMediaUrl); byId("source-message").hidden = true;
  const list = byId("rights-list"); list.replaceChildren();
  for (const [key, label] of [["transcoding", "TRANSCODING"], ["aiTraining", "AI TRAINING"], ["derivatives", "DERIVATIVES"], ["commercialUse", "COMMERCIAL USE"]]) {
    const decision = value.policy[key];
    const row = element("li"); row.append(element("span", label), element("span", decision === "allow" ? "ALLOW" : decision === "deny" ? "DENY" : "UNVERIFIED", `permission ${decision === "allow" ? "allow" : decision === "deny" ? "deny" : "unknown"}`)); list.append(row);
  }
  text("policy-json", JSON.stringify({ policy: value.policy, registeredPolicySHA256: value.policyHash }, null, 2));
  text("policy-requirements", `Attribution ${value.policy.attributionRequired === true ? "required" : "not required"} · Provenance ${value.policy.provenanceRequired === true ? "required" : "not required"}`);
  text("deny-status", "Ready to submit the prohibited request."); controls();
}
function renderDeny(run) {
  denyRun = run;
  const valid = denyEvidence(run, ASSET_ID); byId("deny-receipt").hidden = !valid;
  if (valid) {
    text("deny-reason", `Blocked by registered policy ${run.result.authorization.policyId}.`);
    const checks = byId("deny-checks"); checks.replaceChildren();
    for (const value of [`Processor NOT INVOKED — ${run.calls.processor} calls`, "Provenance NOT CREATED",
      `Solana NOT CALLED — ${run.calls.solana} calls`, "Royalty Event NOT CREATED"]) checks.append(element("li", value));
    text("deny-status", "Canonical DENY receipt received. No downstream execution.");
  } else text("deny-status", run.state === "running" ? "Waiting for the real authorization decision…"
    : "The receipt did not establish the required policy DENY with zero downstream calls. Transcoding remains locked.");
  controls();
}
function setExplorer(url) {
  const link = byId("explorer-link");
  if (url) { link.href = url; link.setAttribute("aria-disabled", "false"); link.removeAttribute("tabindex"); }
  else { link.removeAttribute("href"); link.setAttribute("aria-disabled", "true"); link.tabIndex = -1; }
  text("explorer-status", url ? "Exact signature, provenance commitment and authority independently verified on Devnet." : "Explorer is enabled only after matching independent verification.");
}
function renderEvidence() {
  const list = byId("proof-values"); list.replaceChildren(); byId("evidence-empty").hidden = view.evidence.length > 0;
  for (const [label, value] of view.evidence) {
    const row = element("div"), field = element("dd", `${value.slice(0, 15)}…${value.slice(-12)}`);
    field.title = value;
    const copy = element("button", "Copy", "copy-button"); copy.type = "button"; copy.setAttribute("aria-label", `Copy complete ${label}`);
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(value); text("copy-status", `${label} copied.`); }
      catch { field.textContent = value; text("copy-status", `Full ${label} shown for manual copying.`); }
    });
    row.append(element("dt", label), field, copy); list.append(row);
  }
  const metadata = byId("processing-values"); metadata.replaceChildren();
  if (view.processing) {
    const p = view.processing;
    for (const [label, value] of [["CODEC", `${p.videoCodec.toUpperCase()} / ${p.audioCodec?.toUpperCase() ?? "NO AUDIO"}`],
      ["DIMENSIONS", `${p.width} × ${p.height}`], ["DURATION", `${(p.durationMs / 1000).toFixed(3)} s`], ["TOOL", p.tool]]) {
      const row = element("div"); row.append(element("dt", label), element("dd", value)); metadata.append(row);
    }
  }
  setExplorer(view.explorerUrl); byId("download-button").disabled = !view.proofDownload;
}
function renderAllocation() {
  const allocation = view.allocation; byId("allocation-content").hidden = !allocation; byId("allocation-empty").hidden = Boolean(allocation);
  const body = byId("allocation-rows"); body.replaceChildren();
  if (!allocation) return;
  const labels = { creator: "Creator", rightsholder: "Rightsholder", distributor: "Distributor", infrastructure: "Infrastructure" };
  for (const row of allocation.rows) {
    const tr = element("tr"); tr.append(element("td", labels[row.role]), element("td", `${row.percentage}%`), element("td", row.amount), element("td", String(row.amountMinorUnits))); body.append(tr);
  }
  text("conservation", `RETURNED TOTAL ${allocation.total} ${allocation.currency} / REQUESTED ${allocation.requested} ${allocation.currency}\n${allocation.totalMinorUnits} allocated minor units = ${allocation.requestedMinorUnits} requested minor units`);
  text("allocation-method", `Remainder method: ${allocation.remainderMethod}`); text("royalty-event-id", allocation.eventId);
}
function renderAllow(run) {
  allowRun = run; view = executionView(run);
  const timeline = byId("timeline"); timeline.replaceChildren();
  for (const [i, stage] of view.steps.entries()) {
    const row = element("li", undefined, stage.state);
    row.append(element("span", stage.state === "complete" ? "✓" : stage.state === "failed" || stage.state === "unverified" ? "!" : String(i + 1), "stage-icon"),
      element("span", stage.label, "stage-name"), element("span", stage.detail, "stage-detail"));
    if (stage.observedAt) row.append(element("time", new Date(stage.observedAt).toLocaleTimeString([], { hour12: false }), "stage-time"));
    timeline.append(row);
  }
  const outcome = byId("execution-outcome");
  outcome.textContent = view.complete ? "VERIFIED / ALLOCATED" : view.uncertain ? "UNCERTAIN" : run?.result?.status === "failed" ? "FAILED"
    : run?.state === "running" ? "RUNNING" : run ? "UNVERIFIED" : "NOT STARTED";
  outcome.className = `tag ${view.complete ? "success" : view.uncertain || run?.state === "running" ? "pending" : run ? "error" : ""}`;
  text("execution-message", view.message); byId("execution-message").className = `execution-message ${view.complete ? "success" : ""}`;
  byId("request-reference").hidden = !run;
  if (run) text("request-reference", `REQUEST ${run.requestId}${run.result?.executionId ? ` · EXECUTION ${run.result.executionId}` : ""}`);
  const funds = document.querySelector(".funds-banner strong");
  funds.textContent = run?.result && run.result.fundsTransferred !== false ? "TRANSFER FLAG INCONSISTENT — RECEIPT REJECTED" : "FUNDS TRANSFERRED: NO — ALLOCATION ONLY";
  byId("comparison").hidden = !view.mediaUrl;
  if (view.mediaUrl && asset) {
    media("comparison-source", asset.sourceMediaUrl); media("output-player", view.mediaUrl);
    text("output-format", `${view.processing.videoCodec.toUpperCase()} · ${view.processing.width} × ${view.processing.height} · ${(view.processing.durationMs / 1000).toFixed(3)} s`);
  }
  renderEvidence(); renderAllocation(); controls();
}
async function poll(kind, requestId) {
  while (true) {
    const run = await api(`/executions/${requestId}`);
    if (run.requestId !== requestId) throw new Error("Execution response ID did not match the saved request.");
    if (kind === "denyRequest") renderDeny(run); else renderAllow(run);
    if (run.state !== "running") return;
    // Transport polling only; visible milestone states and timestamps come from the server.
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
function disconnected(error) {
  transportUncertain = true; connection(false); notice(`Execution connection interrupted (${error.message}). Saved request retained. No request was resubmitted.`, true);
  byId("reconnect-button").hidden = !session.denyRequest && !session.allowRequest; controls();
}
async function submit(kind, action) {
  if (busy || transportUncertain || session[kind] || !asset || (action === "transcoding" && !denyEvidence(denyRun, ASSET_ID))) return;
  busy = true; controls(); notice("");
  try {
    const requestId = crypto.randomUUID();
    session[kind] = { requestId, assetId: ASSET_ID, action, derivedAssetId: `demo-${requestId}`,
      ...(action === "transcoding" ? { usageAmount: "100.00" } : {}) };
    remember();
    if (kind === "denyRequest") text("deny-status", "Submitting AI training to the shared authorization gate…");
    else text("execution-message", "Submitting the saved authorized request…");
    const accepted = await api("/actions/execute?async=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(session[kind]) });
    if (accepted.requestId !== requestId) throw new Error("Accepted request identity did not match.");
    await poll(kind, requestId);
  } catch (error) { disconnected(error); }
  finally { busy = false; controls(); }
}
async function reconnect() {
  if (busy) return; busy = true; controls();
  try {
    const health = await api("/health"); if (health.status !== "online") throw new Error("API is not online.");
    for (const kind of ["denyRequest", "allowRequest"]) if (session[kind]) await poll(kind, session[kind].requestId);
    transportUncertain = false; notice(""); byId("reconnect-button").hidden = true;
  } catch (error) { disconnected(error); }
  finally { busy = false; controls(); }
}
byId("deny-button").addEventListener("click", () => void submit("denyRequest", "aiTraining"));
byId("allow-button").addEventListener("click", () => void submit("allowRequest", "transcoding"));
byId("reconnect-button").addEventListener("click", () => void reconnect());
byId("download-button").addEventListener("click", () => {
  if (!view.proofDownload) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(view.proofDownload, null, 2)], { type: "application/json" }));
  const anchor = element("a"); anchor.href = url; anchor.download = `relaystream-proof-${allowRun.result.executionId}.json`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});
byId("source-player").addEventListener("error", () => { byId("source-message").hidden = false; text("source-message", "Source playback unavailable. The API did not provide playable verified media."); });
byId("output-player").addEventListener("error", () => { byId("output-message").hidden = false; text("output-message", "Output playback unavailable. Media delivery may have rejected changed or unavailable bytes; the receipt describes the completed execution."); });
renderAllow(null);
async function initialize() {
  try {
    restore();
    const [health, registered] = await Promise.all([api("/health"), api(`/media/${ASSET_ID}`)]);
    if (health.status !== "online" || health.network !== "solana-devnet" || health.paymentsEnabled !== false) throw new Error("Unexpected API environment.");
    renderAsset(registered);
    if (session.denyRequest || session.allowRequest) await reconnect();
  } catch (error) { disconnected(error); }
}
void initialize();
