# relaystream-rights
Programmable media rights infrastructure on Solana. RelayStream Rights enables machine-readable licensing, permission verification, and provenance so applications and AI agents can determine what they are authorized to do with digital media. Built for Colosseum Crypto World’s Fair 2026.

## Local demo transport (no visual UI yet)

The protocol baseline is commit `362057477c2be7abffe3f67df59fad7d9569d60c`.
Demo mode explicitly registers `test-media/relaystream-demo.mp4`, binds to `127.0.0.1:3000`,
and disables HTTP media registration. Paths and processor configuration are server-owned.

Configure the installed tools for this PowerShell process only, then start:

```powershell
$env:FFMPEG_PATH = 'C:\ffmpeg\bin\ffmpeg.exe'
$env:FFPROBE_PATH = 'C:\ffmpeg\bin\ffprobe.exe'
npm run demo
```

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
allowlist, with no frontend files present in this checkpoint.

`npm run test:demo` uses injected local chain dependencies. The new transport tests submit no
Devnet transactions. Real transcoding tests require the tool environment above. The existing
Devnet integration test remains opt-in (`RUN_DEVNET_INTEGRATION=1`); do not enable it for local tests.

Royalties are deterministic allocation/accounting only: `fundsTransferred` remains `false`.
