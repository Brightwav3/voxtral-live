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
