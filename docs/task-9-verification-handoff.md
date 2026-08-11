# Task 9 verification handoff

Date: 2026-08-11

## Status

The deterministic suite, syntax checks, real daemon startup, local IPC, clean
shutdown, device reopen, and captured-output redaction checks passed. Live TTS
returned a sanitized recoverable provider error, so spoken-output latency and
barge-in quality are not accepted.

## Environment

| Item | Evidence |
| --- | --- |
| Node / npm | v24.14.1 / 11.11.0 |
| Package | `mistral-tts-integration` 0.1.0 |
| Runtime packages | `naudiodon2` 2.5.0; `ws` 8.21.0 |
| Audio probe | 52 PortAudio devices: 27 input, 25 output |
| Used headset devices | input 13 and output 19: Logitech G432 |

## Checks performed

| Check | Result |
| --- | --- |
| `npm test` | PASS: 87 passed, 0 failed, 745.049 ms |
| Node syntax | PASS: `node --check` on 40 `.mjs` files |
| PowerShell syntax | PASS: both service scripts parse |
| `--once` modes | PASS: push-to-talk 174.2 ms; always-on 146.7 ms |
| Real push-to-talk startup | PASS: `daemon_started` and `listening` in 1,084.4 ms |
| Real always-on startup | PASS: `daemon_started` and `listening` in 1,599.4 ms |
| IPC | PASS: `status`, `say`, `interrupt`, and `stop` returned exit code 0 in push-to-talk; `status` and `stop` did so in always-on |
| Shutdown resource release | PASS: after `stop`, a new process opened input 13 and output 19, wrote a silent 24 kHz frame, flushed, and closed in 298.7 ms |
| Forced failure contract | PASS: `test/providers-mistral.test.mjs` forces a failed WebSocket send and asserts sanitized `{ code: "send_failed", recoverable: true }`; the suite also covers sanitized TTS/chat provider failures |
| Secret scan | PASS: three captured daemon stdout/stderr pairs contained neither the configured key nor `Bearer `; `%LOCALAPPDATA%\Voxtral\logs` contained no files |

The fixture `test/fixtures/tts-stream-events.ndjson` is consumed by the TTS
stream parser test. It splits the first Base64 payload across two arbitrary SSE
chunks, then supplies a second audio event and `[DONE]`.

## Recorded live behavior

`npm run daemon -- --mode push-to-talk --input-device 13 --output-device 19`
started, accepted all four IPC commands, and shut down cleanly. `status` showed
`LISTENING`; the command timings, including npm/Node process startup, were
495.0 ms (`status`), 868.7 ms (`say`), 535.5 ms (`interrupt`), and 561.9 ms
(`stop`).

`say "Verification audio."` was accepted but emitted the sanitized event
`{ "code": "invalid_input", "message": "Conversation provider failed",
"recoverable": true }` before audio playback. The session implementation
returns internally to `LISTENING`; it does not emit a second `listening` event
for this recovery. Treat the live TTS/provider configuration as a handoff
blocker for spoken output, not as a passing speech check.

Device ID 43 advertised the same headset family but failed actual daemon input
startup with a sanitized `daemon_start_failed` event. IDs 13/19 worked. Device
IDs are machine-specific; use the README probe before deployment.

## Unverified and known limitations

- UNVERIFIED: five normal microphone turns. No controlled spoken transcript
  sequence was run during this verification window. Run:
  `npm run daemon -- --mode always-on --input-device <in> --output-device <out>`
  and record five final-transcript-to-spoken-answer cycles.
- UNVERIFIED: 20-second barge-in, 10 repetitions, and the 9/10 clean-stop bar.
  Live TTS did not produce audio because of the recoverable `invalid_input`
  event. After fixing provider/model configuration, run a 20-second response,
  speak over it ten times, and capture no stale audio after each `barge_in`.
- UNVERIFIED: live time-to-first-audio and total playback latency. No audio was
  returned, so only startup/control timings above are meaningful.
- UNVERIFIED: Scheduled Task install/uninstall. It changes target-machine task
  state and was intentionally not run; use `npm run service:install -- -StartNow`
  and `npm run service:uninstall` on the deployment machine.
- Speaker-mode barge-in and Czech are unsupported for production. Headset mode
  is the default; Czech requires a separately validated STT/TTS provider.

## Follow-up: configurable Paul - Neutral fallback

The daemon now defaults `voiceId` to the verified Mistral preset
`c69964a6-ab8b-4f8a-9465-ec0925096ec8` (Paul - Neutral) only when
`MISTRAL_VOICE_ID` is absent. An explicit environment value still wins. The
preset is a configurable provider setting, not an official affiliation or
endorsement.

Fresh evidence:

- `npm test`: PASS, 88 passed and 0 failed in 549.208 ms.
- `npm run daemon -- --mode push-to-talk --input-device 13 --output-device 19`:
  PASS: `daemon_started` and `listening` events observed with no configured
  `MISTRAL_VOICE_ID` override.
- `npm run control -- say "Verification audio."`: exit 0. The daemon emitted
  `assistant_started`, `assistant_audio_started`, then the existing sanitized
  recoverable `invalid_input` event; playback still was not observed.
- `npm run control -- stop`: exit 0; daemon process exited 0. Captured output
  contained neither the configured API key nor `Bearer ` headers.

The default voice now reaches the daemon TTS request path, but the live
provider rejection persists. Normal spoken output and barge-in therefore remain
UNVERIFIED pending a provider-side request/model investigation.
