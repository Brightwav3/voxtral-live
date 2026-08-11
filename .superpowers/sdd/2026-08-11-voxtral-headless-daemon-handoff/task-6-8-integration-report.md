# Tasks 6–8 integration report

Date: 2026-08-11

## Status

Implemented the combined session/barge-in, search/delegation, local IPC/CLI,
Windows login-task packaging, documentation, and deterministic test pass.
Tasks 1–5 remain intact and the existing batch/web harness tests still pass.

## Delivered behavior

- Session state is explicit (`IDLE`, `LISTENING`, `THINKING`, `SPEAKING`,
  `INTERRUPTED`, `ERROR`). Every user turn receives a unique `turnId` and
  `generationId` and one shared `AbortController` for LLM, TTS, and delegated
  work. Every async completion checks the active generation before changing
  state or emitting final output.
- VAD speech during thinking/playback stops the playback queue, aborts active
  work, emits `barge_in`/`assistant_cancelled`, allocates the next generation,
  and forwards the triggering frame to the long-lived STT stream immediately.
- Headset is the default profile. Speaker mode requires
  `--audio-profile speaker --echo-cancel` and uses a rolling output-reference
  correlation suppressor before accepting a barge-in frame.
- `web_search({ query, recencyDays })` is application-owned and validated. The
  provider accepts an injected implementation or JSON endpoint, returns only
  normalized `{ title, url, snippet, publishedAt }` records, strips HTML, and
  supports `AbortSignal` cancellation.
- Delegated jobs carry `conversationId`/`turnId`, acknowledge immediately,
  abort/discard after a newer turn, attach structured citations to
  `assistant_final`, and remove raw URLs from all TTS-facing text.
- Local control uses newline-delimited JSON request/response frames on
  `\\.\pipe\voxtral-daemon`. It supports `status`, `say`, `interrupt`, and
  `shutdown`, rejects duplicate pipe owners, and rejects new clients after
  shutdown begins. No network listener is added.
- `voxtral status`, `voxtral say TEXT`, `voxtral interrupt`, and `voxtral stop`
  are exposed through the package bin and `npm run control -- ...`.
- Windows install/uninstall scripts register a current-user Scheduled Task at
  login, restart it after crashes, log under
  `%LOCALAPPDATA%\Voxtral\logs`, gracefully stop through IPC, and never read,
  copy, print, or persist `.env` contents.

## Files

Created:

- `src/audio/echo-suppressor.mjs`
- `src/conversation/cancellation.mjs`
- `src/conversation/session.mjs`
- `src/conversation/delegation.mjs`
- `src/providers/web-search.mjs`
- `src/control-ipc.mjs`
- `src/control-cli.mjs`
- `scripts/install-windows-service.ps1`
- `scripts/uninstall-windows-service.ps1`
- `test/session.test.mjs`
- `test/delegation.test.mjs`
- `test/control-ipc.test.mjs`
- `test/echo-suppressor.test.mjs`

Modified:

- `src/config.mjs`
- `src/daemon.mjs`
- `src/providers/mistral-chat.mjs`
- `test/daemon-contract.test.mjs`
- `test/mistral-chat.test.mjs`
- `package.json`
- `package-lock.json`
- `README.md`

## Verification

Baseline before integration:

```text
npm test
60 passed, 0 failed
```

Focused integration verification:

```text
npm test -- test/session.test.mjs test/delegation.test.mjs test/control-ipc.test.mjs test/daemon-contract.test.mjs test/mistral-chat.test.mjs test/echo-suppressor.test.mjs
30 passed, 0 failed
```

Full verification after implementation:

```text
npm test
76 passed, 0 failed
```

Additional checks:

```text
node --check (all changed production .mjs files)
Node syntax OK

PowerShell parser: install-windows-service.ps1 and uninstall-windows-service.ps1
PowerShell syntax OK

git diff --check
No whitespace errors (Git reported only the repository's LF-to-CRLF warnings)
```

## Concerns and live validation

- No live microphone, speaker, Mistral request, external search endpoint, or
  Scheduled Task installation was exercised in this deterministic pass. Those
  operations need target-machine credentials/devices and would change external
  state.
- The bundled speaker echo suppressor is correlation-based, not a full acoustic
  echo canceller. Headset mode remains the reliable default; speaker thresholds
  and device latency need live tuning.
- Web search is fully wired but intentionally provider-neutral. It returns a
  structured `search_unavailable` error until `VOXTRAL_SEARCH_ENDPOINT` or an
  injected search implementation is configured.

## Integration fix round 1 — 2026-08-11

### Review findings addressed

- Playback completion is now explicit. The audio backend exposes
  `flushOutput()`, queued frames remain part of the active `SPEAKING` phase
  until their device-drain promises settle, and speech detected during that
  tail follows the normal barge-in path.
- Speaker-mode echo frames are filtered before the stateful VAD and reset its
  attack state. Sustained correlated playback no longer latches VAD, while an
  immediately following non-correlated human frame still starts a barge-in.
- Realtime STT finals carry the originating `turnId` and `generationId`.
  Session callbacks require both identities to match the active turn, so a
  delayed pre-barge final cannot replace a newer result.
- Daemon startup now acquires named-pipe singleton ownership before opening STT
  or microphone resources. `daemon_started` is emitted only after ownership,
  STT, and audio startup all succeed; bind failure starts neither resource.
- IPC shutdown now awaits session/audio cleanup and flushes its response before
  closing the server. The synchronous uninstall CLI therefore does not proceed
  to Scheduled Task removal until daemon cleanup has completed.
- Windows pipe names are SID-qualified (`voxtral-daemon-<SID>`), isolating the
  control endpoint per Windows user. `voxtral say` now applies the same
  URL-removing TTS sanitization used by generated/delegated speech.
- Existing cancellable search and delegation behavior remains covered and
  unchanged.

### Regression evidence

The new tests were observed failing before implementation for premature
`LISTENING`, missing drain support, URL leakage, stateful-VAD latching, stale
STT acceptance, missing turn identity, global pipe naming, early resource
startup, and early shutdown acknowledgement.

Focused integration verification:

```text
npm test -- test/audio-backend.test.mjs test/playback-queue.test.mjs test/session.test.mjs test/providers-mistral.test.mjs test/delegation.test.mjs test/mistral-chat.test.mjs test/control-ipc.test.mjs test/daemon-contract.test.mjs test/echo-suppressor.test.mjs
54 passed, 0 failed
```

Full verification:

```text
npm test
85 passed, 0 failed
```

Syntax and scope checks:

```text
node --check (all five changed production .mjs files)
Node syntax OK

PowerShell parser: install-windows-service.ps1 and uninstall-windows-service.ps1
PowerShell syntax OK

git diff --check
No whitespace errors (Git reported only the repository's LF-to-CRLF warnings)
```

### Remaining live validation

- Deterministic tests inject the playback drain boundary; the production
  PortAudio adapter uses frame-duration completion after each device write.
  Actual driver buffering and speaker-mode correlation thresholds still need
  target-device tuning with live audio.
- No live Mistral, search endpoint, microphone/speaker, or Scheduled Task
  installation was exercised. Search/delegation cancellation is preserved by
  the full deterministic suite.
