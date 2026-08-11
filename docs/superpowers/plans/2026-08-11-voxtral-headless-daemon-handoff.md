# Voxtral Headless Voice Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a headless Windows background daemon that listens through the system microphone, reasons with a Mistral LLM, speaks through the system speakers, and supports real barge-in after the user enters a Mistral API key in `.env`.

**Architecture:** Keep Node.js as the orchestration runtime and isolate microphone/speaker access behind an `AudioBackend` interface. The daemon owns one long-lived voice session: PCM input flows to Voxtral Realtime STT, finalized turns flow to a streaming Mistral chat model, sentence-sized text flows to Voxtral TTS, and PCM output flows to a cancellable playback queue. Barge-in is detected locally before transcription completes; it invalidates the current generation, stops playback, aborts LLM/TTS work, and starts the next turn.

**Tech Stack:** Node.js 24 (minimum Node 20.6), `ws` for the Mistral realtime WebSocket, `naudiodon2` 2.5.0 / PortAudio for Windows audio I/O, built-in `AbortController`, `FormData`, `fetch`, and Node test runner. Keep the existing TTS and batch-transcription adapters as offline fallbacks.

## Global Constraints

- The shipped product has no browser UI, HTML server, or required local web page.
- The daemon starts with `npm run daemon` and reads `MISTRAL_API_KEY` from `.env`.
- The API key must never appear in stdout, JSONL events, error messages, or crash dumps.
- Audio input is mono PCM 16 kHz, 16-bit little-endian in 20 ms frames.
- TTS playback uses Voxtral `pcm` streaming; the adapter must convert or route the returned float32 PCM to the output device without waiting for the whole answer.
- Default realtime model is `voxtral-mini-transcribe-realtime-2602`; default TTS model is `voxtral-mini-tts-latest`.
- The first supported speech profile is English because Mistral's published STT/TTS language lists do not include Czech. Unsupported language requests emit a structured error instead of silently pretending to support them.
- Every new production behavior follows RED → GREEN → REFACTOR with `npm test` evidence.
- The existing `public/` web UI is a disposable development harness, not part of the daemon build. Keep it only until daemon acceptance passes, then move it under `experiments/ui/` or remove it in a separate cleanup commit.

## Product contract

### Process commands

```powershell
npm run daemon
npm run daemon -- --mode push-to-talk
npm run daemon -- --mode always-on
npm run control -- status
npm run control -- interrupt
npm run control -- say "Hello"
```

`always-on` is the default background mode. `push-to-talk` is the privacy and debugging fallback. `control` communicates with the daemon through a local named pipe; it does not start another AI session.

### Event contract

Emit one JSON object per line to stdout and to the local IPC event stream:

```json
{"event":"daemon_started","sessionId":"s_01","mode":"always-on"}
{"event":"listening","sessionId":"s_01"}
{"event":"user_started","turnId":"t_04"}
{"event":"user_transcript","turnId":"t_04","text":"Give me a simple cheeseburger recipe.","final":true}
{"event":"assistant_started","turnId":"t_04"}
{"event":"assistant_audio_started","turnId":"t_04"}
{"event":"barge_in","turnId":"t_04","newTurnId":"t_05"}
{"event":"assistant_cancelled","turnId":"t_04","reason":"barge_in"}
{"event":"error","code":"mistral_request_failed","recoverable":true}
```

No event may include the API key, raw microphone audio, or full provider payloads. Include provider request IDs only when they are not secrets.

## Target file structure

```text
src/
  daemon.mjs                         process entrypoint and shutdown
  config.mjs                         environment and CLI config validation
  control-cli.mjs                    status/interrupt/say commands
  events.mjs                         JSONL event schema and redaction
  audio/
    audio-backend.mjs                interface and shared PCM types
    portaudio-backend.mjs            naudiodon2 input/output implementation
    vad.mjs                          local speech activity detector
    playback-queue.mjs               cancellable PCM playback queue
  providers/
    mistral-realtime-stt.mjs         Voxtral realtime WebSocket adapter
    mistral-chat.mjs                 streaming chat and tool calls
    mistral-tts-stream.mjs            text/event-stream to PCM adapter
    web-search.mjs                   application-owned web search tool
  conversation/
    session.mjs                      state machine and generation IDs
    turn-controller.mjs               partial/final transcript decisions
    sentence-chunker.mjs              stream text into speakable clauses
    cancellation.mjs                  AbortController and stale-result guards
test/
  audio-vad.test.mjs
  playback-queue.test.mjs
  turn-controller.test.mjs
  sentence-chunker.test.mjs
  session.test.mjs
  providers-mistral.test.mjs
  daemon-contract.test.mjs
```

## Task 1: Replace the web-product target with daemon configuration

**Files:**
- Create: `src/config.mjs`
- Create: `src/events.mjs`
- Create: `src/daemon.mjs`
- Create: `test/daemon-contract.test.mjs`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**

```js
export function loadConfig(env = process.env, argv = []) {
  return {
    apiKey,
    mode: 'always-on' | 'push-to-talk',
    sttModel,
    llmModel,
    ttsModel,
    voiceId,
    sampleRate: 16000,
    frameMs: 20,
  };
}

export function emitEvent(event, write = process.stdout.write) {
  write(`${JSON.stringify(redactEvent(event))}\n`);
}
```

- [ ] Write a failing test for missing `MISTRAL_API_KEY`, invalid mode, and successful default config.
- [ ] Run `npm test -- test/daemon-contract.test.mjs` and confirm the new module is missing.
- [ ] Implement config validation and event redaction. Reject empty API keys and never echo their values.
- [ ] Add `daemon` and `control` scripts without removing the working `tts` and `transcribe` scripts.
- [ ] Run the focused test and then `npm test`.
- [ ] Document the exact `.env` keys and the event contract in `README.md`.

## Task 2: Implement system microphone/speaker access

**Files:**
- Create: `src/audio/audio-backend.mjs`
- Create: `src/audio/portaudio-backend.mjs`
- Create: `src/audio/vad.mjs`
- Create: `src/audio/playback-queue.mjs`
- Create: `test/audio-vad.test.mjs`
- Create: `test/playback-queue.test.mjs`
- Modify: `package.json`

**Interfaces:**

```js
export function createAudioBackend(options = {}) {
  return {
    async startInput(onFrame),
    writeOutput(pcmFloat32Frame),
    stopOutput(),
    async close(),
  };
}

export function createVad({ sampleRate: 16000, frameMs: 20, startRms, stopRms, stopAfterMs }) {
  return { push(frame), reset() };
}
```

- [ ] Write deterministic VAD tests with silence, speech, speech-to-silence, and a short interruption during playback.
- [ ] Write playback queue tests proving `stopOutput()` discards all queued frames and does not play stale audio.
- [ ] Run the focused tests and confirm the interfaces fail before implementation.
- [ ] Install `naudiodon2@2.5.0` and implement a 16 kHz mono int16 input stream plus a 24 kHz mono float32 output stream.
- [ ] Add device selection flags `--input-device` and `--output-device`; default to the Windows system devices.
- [ ] Add conservative VAD defaults: 20 ms frames, 60 ms speech attack, 450 ms release, and a configurable RMS threshold.
- [ ] Run tests and a manual 10-second audio loopback that prints frame counts without sending audio to Mistral.

**Acceptance:** the daemon can open the default microphone and speakers, close both cleanly on Ctrl+C, and stop playback within one audio frame after `stopOutput()`.

## Task 3: Connect Voxtral Realtime STT

**Files:**
- Create: `src/providers/mistral-realtime-stt.mjs`
- Create: `test/providers-mistral.test.mjs`
- Modify: `src/config.mjs`

**Interface:**

```js
export function createRealtimeTranscriber({ apiKey, model, targetDelayMs, WebSocketImpl }) {
  return {
    async connect(),
    pushAudio(pcmS16leFrame),
    on(eventName, handler),
    async close(),
  };
}
```

- [ ] Add fake-WebSocket tests for session creation, text deltas, final transcript, provider error, reconnect, and close.
- [ ] Run the tests and verify the adapter is missing.
- [ ] Implement the adapter for `voxtral-mini-transcribe-realtime-2602` with 16 kHz `pcm_s16le` frames.
- [ ] Use `target_streaming_delay_ms=240` for the fast assistant path; expose `--stt-delay-ms` for tuning.
- [ ] Map provider messages to `partial`, `final`, `session_ready`, `error`, and `closed` events. Do not leak raw payloads into the daemon event stream.
- [ ] Run a live microphone session and verify `user_started`, partial text, and final text events.

The official realtime model and streaming behavior are documented by Mistral here: [Realtime transcription](https://docs.mistral.ai/studio-api/audio/speech_to_text/realtime_transcription).

## Task 4: Add turn control and the foreground LLM

**Files:**
- Create: `src/conversation/turn-controller.mjs`
- Create: `src/conversation/sentence-chunker.mjs`
- Create: `src/providers/mistral-chat.mjs`
- Create: `test/turn-controller.test.mjs`
- Create: `test/sentence-chunker.test.mjs`

**Interfaces:**

```js
export function createTurnController({ silenceMs: 550, minWords: 1 }) {
  return { pushPartial(text), pushFinal(text), on(eventName, handler), reset() };
}

export function createSentenceChunker({ maxChars: 220 }) {
  return { push(delta), flush(), reset() };
}

export async function* streamChat({ apiKey, model, messages, tools, signal, fetchImpl }) {}
```

- [ ] Test that unstable partial text never starts an LLM request.
- [ ] Test that a final transcript creates exactly one turn and a silence timeout does not duplicate it.
- [ ] Test sentence chunking on punctuation, long clauses, abbreviations, and a final flush.
- [ ] Implement streaming chat with a compact system prompt that tells the model to speak in short, natural sentences and never emit Markdown.
- [ ] Keep a bounded conversation history: last 12 turns plus a rolling summary once the context exceeds the configured token budget.
- [ ] Emit `assistant_text_delta` and `assistant_sentence_ready` events.

Default foreground model: `mistral-small-latest` for latency. Make `MISTRAL_LLM_MODEL` configurable so the user can switch to a larger model without code changes.

## Task 5: Stream Voxtral TTS and play it incrementally

**Files:**
- Create: `src/providers/mistral-tts-stream.mjs`
- Modify: `src/mistral-tts.mjs`
- Create: `test/tts-stream.test.mjs`

**Interface:**

```js
export async function* streamSpeech({
  apiKey,
  model,
  input,
  voiceId,
  refAudio,
  signal,
  fetchImpl,
}) {}
```

- [ ] Write a parser test with captured `text/event-stream` chunks split at arbitrary byte boundaries.
- [ ] Test that an abort signal stops iteration and no audio after abort reaches `writeOutput`.
- [ ] Implement `stream: true`, `response_format: 'pcm'`, and Base64 audio chunk decoding.
- [ ] Feed each decoded PCM chunk to `playback-queue.mjs` immediately; do not buffer the whole sentence.
- [ ] Preserve the working non-streaming TTS path for CLI and batch use.
- [ ] Run one live sentence and measure time-to-first-audio and total playback time.

Mistral documents PCM as the low-latency streaming format and TTS streaming as `text/event-stream`: [Speech generation](https://docs.mistral.ai/studio-api/audio/text_to_speech/speech) · [Audio speech API](https://docs.mistral.ai/api/endpoint/audio/speech).

## Task 6: Implement session state and real barge-in

**Files:**
- Create: `src/conversation/cancellation.mjs`
- Create: `src/conversation/session.mjs`
- Create: `test/session.test.mjs`
- Modify: `src/daemon.mjs`

**State machine:**

```text
IDLE → LISTENING → THINKING → SPEAKING
                         ↘ ERROR
SPEAKING → INTERRUPTED → LISTENING
```

- [ ] Write tests proving each turn gets a unique `turnId` and `generationId`.
- [ ] Write the core barge-in test: while TTS generation N is playing, VAD speech start increments the generation, calls `stopOutput()`, aborts LLM/TTS, emits `barge_in`, and accepts generation N+1 audio only.
- [ ] Implement one `AbortController` per LLM/TTS turn and a stale-result guard on every async callback.
- [ ] Start the next STT turn immediately after interruption; do not wait for the cancelled provider request to finish.
- [ ] Add playback echo suppression. Headset mode is the initial reliable profile; speaker mode must expose an explicit `--echo-cancel` setting and be tested separately.
- [ ] Run a live test: speak while a 20-second TTS answer is playing and verify assistant audio stops before the new final transcript is complete.

**Acceptance:** no audio from an old generation is audible after `barge_in`; no cancelled result can overwrite the new conversation state.

## Task 7: Add web search and background delegation without blocking speech

**Files:**
- Create: `src/providers/web-search.mjs`
- Create: `src/conversation/delegation.mjs`
- Create: `test/delegation.test.mjs`
- Modify: `src/providers/mistral-chat.mjs`

- [ ] Define the app-owned tool schema `web_search({ query, recencyDays })` and test validation.
- [ ] Implement the search provider behind an interface that returns `{ title, url, snippet, publishedAt }[]` and never returns raw HTML to the LLM.
- [ ] Make the foreground assistant acknowledge a long search in one short sentence while the worker runs asynchronously.
- [ ] Tag every delegated job with `conversationId` and `turnId`; discard results after barge-in or a newer user turn.
- [ ] Add citations to the final text event and make the TTS sentence omit raw URLs.

Mistral's built-in `web_search` is available through Conversations/Agents rather than standard Chat Completions. The first daemon implementation should therefore keep a provider-owned search tool boundary so the realtime path remains cancellable: [Mistral web search](https://docs.mistral.ai/studio-api/agents/agent-tools/websearch).

## Task 8: Add local IPC and background-service packaging

**Files:**
- Create: `src/control-ipc.mjs`
- Create: `src/control-cli.mjs`
- Create: `scripts/install-windows-service.ps1`
- Create: `scripts/uninstall-windows-service.ps1`
- Create: `test/control-ipc.test.mjs`
- Modify: `package.json`
- Modify: `README.md`

- [ ] Write IPC tests for `status`, `say`, `interrupt`, and `shutdown` with one daemon instance.
- [ ] Implement a per-user Windows named pipe `\\.\pipe\voxtral-daemon` with JSON request/response frames.
- [ ] Reject requests from a second control client while a shutdown is in progress; do not expose a network port.
- [ ] Add `voxtral status`, `voxtral say TEXT`, `voxtral interrupt`, and `voxtral stop` commands.
- [ ] Add a Windows service installer that runs under the current user, starts after login, writes logs to `%LOCALAPPDATA%\Voxtral\logs`, and never writes `.env` contents to disk.
- [ ] Document recovery after a crash, service stop, device selection, model selection, and log redaction.

## Task 9: Verification and handoff gate

**Files:**
- Create: `test/fixtures/tts-stream-events.ndjson`
- Create: `docs/decisions/ADR-001-headless-background-daemon.md`
- Modify: `README.md`

- [ ] Run `npm test` with zero failures.
- [ ] Run `npm run daemon -- --mode push-to-talk` and verify microphone open/close.
- [ ] Run `npm run daemon -- --mode always-on` with a headset and complete five turns.
- [ ] Run the 20-second barge-in test ten times; require at least 9/10 clean stops with no stale audio.
- [ ] Verify `npm run control -- status` and `npm run control -- interrupt` while the daemon is speaking.
- [ ] Verify a forced network failure produces a recoverable event and returns to `LISTENING`.
- [ ] Verify API key redaction by scanning captured logs for the key value and `Bearer ` headers.
- [ ] Verify clean shutdown releases the microphone and speaker so another process can open them.
- [ ] Write a short handoff report containing Node version, package versions, audio devices, latency measurements, and known limitations.

## Definition of done

- No browser window or web server is required for normal operation.
- After `.env` contains `MISTRAL_API_KEY`, `npm run daemon` opens the default microphone and speakers.
- A normal turn produces a spoken answer without waiting for the complete LLM response.
- Speaking over the assistant stops the old audio immediately and starts a fresh turn.
- `status`, `say`, `interrupt`, and `stop` work through local IPC.
- All tests pass, live smoke tests are recorded, and logs contain no secrets.
- Czech is reported as unsupported by the default Mistral speech profile rather than silently presented as production-ready.

## Known risks and mitigation

| Risk | Mitigation |
|---|---|
| PortAudio native build breaks on a target Windows machine | Pin `naudiodon2`, ship a tested Node version, and isolate `AudioBackend` so a Rust/CPAL worker can replace it without changing the session engine. |
| Speaker output triggers the microphone | Ship headset mode first; add echo-reference processing before claiming reliable speaker-mode barge-in. |
| TTS stream format changes | Keep a captured event fixture, parse provider chunks behind one adapter, and fail closed on unknown event shapes. |
| Czech speech quality is unacceptable | Keep language/provider adapters separate and add a Czech STT/TTS provider without changing the LLM or turn controller. |
| Search blocks the conversation | Run search as a cancellable delegation job and return only tagged results to the current turn. |
