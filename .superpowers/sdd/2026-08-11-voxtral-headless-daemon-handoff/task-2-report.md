# Task 2 report: system microphone/speaker access

## Status

Implemented the hardware-optional audio boundary, deterministic local VAD, cancellable playback queue, `naudiodon2` PortAudio backend, and device-selection configuration.

## Changed files

- `src/audio/audio-backend.mjs` — public `createAudioBackend` interface.
- `src/audio/portaudio-backend.mjs` — lazy `naudiodon2` input/output backend: 16 kHz mono signed-int16 input in 320-sample frames, 24 kHz mono float32 output, default system devices, and clean close.
- `src/audio/vad.mjs` — deterministic RMS VAD with 20 ms frames, 60 ms attack, 450 ms release, configurable thresholds, and PCM float32/int16 support.
- `src/audio/playback-queue.mjs` — generation-based playback queue; `stopOutput()` clears queued and not-yet-started stale frames.
- `src/config.mjs` — `--input-device <id>` and `--output-device <id>` parsing.
- `test/audio-vad.test.mjs` — silence, attack, PCM int16, release, and playback-interruption coverage.
- `test/playback-queue.test.mjs` — ordering, queue cancellation, and stale-frame coverage.
- `test/daemon-contract.test.mjs` — CLI device-flag coverage.
- `package.json` and `package-lock.json` — exact `naudiodon2@2.5.0` dependency.

## Test evidence

1. `npm test -- test/audio-vad.test.mjs test/playback-queue.test.mjs`
   - 8 passing, 0 failing.
2. `npm test -- test/daemon-contract.test.mjs test/audio-vad.test.mjs test/playback-queue.test.mjs`
   - 16 passing, 0 failing.
3. `node --input-type=module -e "import('naudiodon2') ..."`
   - `naudiodon2 import ok`.
4. `npm test`
   - 29 passing, 0 failing.
5. `git diff --check`
   - no whitespace errors.

## Concerns

- No microphone or speaker was opened during automated verification, so a 10-second live loopback must be run on the target Windows hardware before accepting device-driver behavior.
- `stopOutput()` prevents queued and pre-write stale frames; a PortAudio write that has already entered the driver cannot be cancelled by JavaScript, so the effective interruption bound is one output frame (20 ms at 24 kHz / 480 samples).
- The audio backend is intentionally not wired into the daemon session yet; later tasks own STT/session integration and call this interface.

## Review fix round 1

### Fixed findings

- **P0: active stale output after cancellation** — `stopOutput()` now increments the queue generation, clears queued frames, and calls `quit()` on the active PortAudio output stream. A generation callback rechecks cancellation after lazy backend loading, so an old frame cannot create or write to a new stream after interruption.
- **P1: close during lazy input start** — the backend now tracks `closed` and `inputStarting`; duplicate starts reject, closed backends reject new writes/starts, and input/output loading rechecks both closure and generation before stream construction or playback.
- **P2: unused interruption test** — removed the unused boolean test and replaced it with a fake-PortAudio integration test that drives VAD speech attack, stops real backend output, verifies the original stream is quit, and verifies only fresh audio reaches a replacement stream.

### Added hardware-free lifecycle coverage

- exact input/output PortAudio stream options and device IDs;
- clean shutdown of input and output streams;
- close while input startup is pending;
- concurrent input-start rejection;
- active-output cancellation and stale-frame discard.

### Fix verification

1. `npm test -- test/audio-backend.test.mjs test/audio-vad.test.mjs test/playback-queue.test.mjs test/daemon-contract.test.mjs`
   - 19 passing, 0 failing.
2. `npm test`
   - 32 passing, 0 failing.
3. `git diff --check`
   - no whitespace errors.

### Remaining concern

`quit()` is the available PortAudio stream-reset mechanism used to halt already-buffered device output. The code-level one-frame cancellation path is covered with a fake backend; the driver-level stop latency still requires target Windows hardware validation.
