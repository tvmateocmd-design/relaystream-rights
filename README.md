# relaystream-rights
Programmable media rights infrastructure on Solana. RelayStream Rights enables machine-readable licensing, permission verification, and provenance so applications and AI agents can determine what they are authorized to do with digital media. Built for Colosseum Crypto World’s Fair 2026.

## Local judge-facing demo

The protocol baseline is commit `362057477c2be7abffe3f67df59fad7d9569d60c`.
Demo mode explicitly registers `test-media/relaystream-demo.mp4`, binds to `127.0.0.1:3000`,
and disables HTTP media registration. Paths and processor configuration are server-owned.

Configure the installed tools for this PowerShell process only, then start:

```powershell
$env:FFMPEG_PATH = 'C:\ffmpeg\bin\ffmpeg.exe'
$env:FFPROBE_PATH = 'C:\ffmpeg\bin\ffprobe.exe'
npm run demo
```

Open `http://127.0.0.1:3000`. Demonstrate **Request AI Training** first; only a canonical
policy DENY with zero downstream calls unlocks **Transcode Authorized Media**. Transcoding
submits usage `100.00` in `USD-DEMO`. Progress, proofs and allocation come from the backend
receipts. This command uses the configured Devnet signer and real anchoring workflow.

The page saves request IDs in tab session storage before submission. Refreshing and
**Reconnect to saved request** fetch existing status only; they never resubmit execution.
If a submission is uncertain or its receipt was lost after server restart, retain the saved
request for reconciliation. Do not clear it to retry uncertain work.

Endpoints:

- `GET /health`
- `GET /media/relaystream-demo-001` (policy, hashes and source URL)
- `GET` / `HEAD /media/relaystream-demo-001/source` (verified MP4, single GET byte range)
- `POST /actions/execute?async=1` with `{requestId, assetId, action, derivedAssetId, usageAmount?}`
- `GET /executions/:requestId` (actual milestones, observed dependency counts and sanitized result)
- `GET` / `HEAD /executions/:requestId/output` (only completed independently verified media)

Generate a UUID request ID before submission and retain it on the client. Identical repeats reuse
the same run; conflicting repeats return 409. One execution can be active. The session registry
holds at most 100 requests and never evicts IDs for replay; capacity exhaustion returns 429.
No automatic execution or anchoring retry is performed. Unknown submission state is preserved
without royalty release. Restarting loses session receipts and must not be used to retry uncertain work.

Synchronous `/actions/execute` retains its terminal-result behavior (403 blocked, 422 failed,
200 completed). Demo responses omit physical paths and exception diagnostics. Non-demo API
mode retains the existing registration and synchronous workflow.

Media serving accepts no client paths, restricts the source to the fixed fixture and outputs to
their execution-owned `output.mp4`, rejects path/link escapes, and verifies complete bytes before
serving the same buffer. This local demo caps media at 16 MiB. Frontend serving is an explicit
allowlist for the HTML, CSS and two browser modules; tests and other files are not served.

`npm run test:demo` uses injected local chain dependencies. The new transport tests submit no
Devnet transactions. Real transcoding tests require the tool environment above. The existing
Devnet integration test remains opt-in (`RUN_DEVNET_INTEGRATION=1`); do not enable it for local tests.

`npm run test:interface` exercises the real HTTP authorization and FFmpeg workflow with
injected chain dependencies, then checks receipt presentation, milestone ordering, Explorer
gating, fail-closed evidence, accessible controls and responsive structure. It submits no
Devnet transaction. Allocation rows and conservation evidence are rendered from returned
events; the browser never calculates new allocation amounts.

Royalties are deterministic allocation/accounting only: `fundsTransferred` remains `false`.
