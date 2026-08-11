# Task 5 report — Stream Voxtral TTS and play it incrementally

## Status

Implemented and verified. The streaming adapter consumes `text/event-stream` incrementally, decodes each Base64 PCM chunk as it arrives, and stops cleanly when aborted. The established non-streaming `synthesizeSpeech` batch/CLI path is unchanged.

## Changed files

- `src/providers/mistral-tts-stream.mjs` — new abortable Voxtral streaming TTS provider with SSE parsing, PCM chunk decoding, and secret-safe structured errors.
- `src/mistral-tts.mjs` — re-exports `streamSpeech` without changing `synthesizeSpeech`.
- `test/tts-stream.test.mjs` — deterministic fake-fetch coverage for split SSE boundaries, PCM chunks, abort/write behavior, and sanitized provider/malformed-stream errors.

## Test commands and output

1. `npm test -- test/tts-stream.test.mjs test/mistral-tts.test.mjs`
   - Passed: 7 tests, 0 failures.
2. `npm test`
   - Passed: 59 tests, 0 failures.

## Concerns

- The provider contract is covered with deterministic SSE fixtures; live Mistral streaming should be validated separately to confirm the production event field name and PCM stream parameters.

---

## Fix round 1

### Status

Implemented and verified. `playStreamingSpeech` is the production-facing incremental playback helper: it consumes `streamSpeech`, converts little-endian PCM16 chunks to the audio backend's `Float32Array` output frames, and stops before writing further audio when the abort signal fires. It retains at most one trailing PCM byte between chunks.

### Changed files

- `src/mistral-tts.mjs` — exports `playStreamingSpeech` while preserving `synthesizeSpeech` unchanged.
- `src/providers/mistral-tts-stream.mjs` — accepts `baseUrl`, defaults from `MISTRAL_BASE_URL`, and consistently targets that configured endpoint.
- `test/tts-stream.test.mjs` — end-to-end fake-fetch/fake-backend coverage proves configured endpoint use, incremental frame delivery, PCM conversion, and no writes after abort.

### Test commands and output

1. `npm test -- test/tts-stream.test.mjs test/mistral-tts.test.mjs`
   - Passed: 8 tests, 0 failures.
2. `npm test`
   - Passed: 60 tests, 0 failures.

### Concerns

- Live provider validation remains useful to confirm the SSE payload schema and PCM sample format exposed by Mistral.
