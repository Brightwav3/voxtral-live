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

## Task 3 Fix Round 1

### Status

Fixed the review findings. `session.update` now uses the provider shape with
`audio_format` and `target_streaming_delay_ms` nested under `session`. WebSocket
sends now reject when `bufferedAmount` exceeds the 1 MiB cap and convert failed
sends into sanitized recoverable adapter errors. Reconnect, close, and secret
redaction behavior remain covered.

### Changed files

- `src/providers/mistral-realtime-stt.mjs` — corrected session payload nesting
  and added bounded backpressure checks with explicit rejection.
- `test/providers-mistral.test.mjs` — updated the provider payload expectation
  and added deterministic high-buffer and failed-send tests.
- This report — appended the fix-round status and verification record.

### Test commands and output

1. `node --test test/providers-mistral.test.mjs`
   - Passed: 8 tests, 0 failed.
2. `npm test`
   - Passed: 40 tests, 0 failed.

### Concerns

- The adapter still has no live microphone/provider session validation in this
  round; the fix is verified at the fake-WebSocket boundary.
