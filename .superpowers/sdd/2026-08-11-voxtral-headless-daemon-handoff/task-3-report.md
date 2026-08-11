# Task 3 Report — Connect Voxtral Realtime STT

## Status

Implemented and verified the realtime STT adapter. The adapter starts a Mistral
realtime session using the Voxtral realtime model, 16 kHz `pcm_s16le`, and a
240 ms default streaming delay. It accepts injectable WebSocket implementations
for deterministic tests, sends base64 PCM frames only after the socket opens,
and exposes sanitized `partial`, `final`, `session_ready`, `error`, and
`closed` events.

## Changed files

- `src/providers/mistral-realtime-stt.mjs` — realtime WebSocket adapter with
  safe lifecycle, reconnect-after-unexpected-close support, and sanitized
  provider event mapping.
- `src/config.mjs` — adds `sttDelayMs`, configurable through
  `--stt-delay-ms` (positive integer; default 240).
- `test/providers-mistral.test.mjs` — fake-WebSocket tests for session setup,
  partial/final transcript mapping, provider errors, reconnect, close, and the
  config flag.
- `test/daemon-contract.test.mjs` — updates exact config expectations for the
  new default.
- `package.json` and `package-lock.json` — adds `ws@8.21.0` for authenticated
  Node WebSocket connections.

## Test commands and output

1. `node --test test/providers-mistral.test.mjs`
   - Passed: 6 tests, 0 failed.
2. `npm test`
   - Passed: 38 tests, 0 failed.
3. `npm audit --omit=dev --json`
   - Passed: 0 vulnerabilities.

The focused suite was first run before implementation and failed as expected
because `src/providers/mistral-realtime-stt.mjs` did not exist.

## Concerns

- No live microphone/Mistral session was run: this task validates the protocol
  boundary using fake WebSockets and does not wire the adapter into the daemon
  yet.
