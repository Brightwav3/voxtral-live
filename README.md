# Mistral Voxtral headless daemon

Voxtral runs as one local Windows voice daemon. Microphone PCM streams to
Voxtral Realtime STT, finalized turns stream through Mistral chat, and
sentence-sized output streams to Voxtral TTS and the selected speaker. Local
VAD can cancel an in-flight LLM/TTS generation before transcription finishes.

The browser files under `public/` are a development harness. They are not
required by the daemon and the daemon exposes no network port.

## Setup

Use Node.js 20.6 or newer and create a private `.env` in the project root:

```dotenv
MISTRAL_API_KEY=your-key
VOXTRAL_MODE=always-on
MISTRAL_STT_MODEL=voxtral-mini-transcribe-realtime-2602
MISTRAL_LLM_MODEL=mistral-small-latest
MISTRAL_TTS_MODEL=voxtral-mini-tts-latest
MISTRAL_VOICE_ID=optional-voice-id
```

`MISTRAL_API_KEY` is required. `VOXTRAL_MODE` is `always-on` by default or
`push-to-talk`. An optional `VOXTRAL_SEARCH_ENDPOINT` may point to an
application-owned JSON search service that accepts
`{ "query": string, "recencyDays"?: number }` and returns a JSON array (or a
`results` array) containing only `title`, `url`, `snippet`, and `publishedAt`.

Install dependencies and start the reliable headset profile:

```powershell
npm install
npm run daemon
```

Select devices and models without changing code:

```powershell
npm run daemon -- --input-device 2 --output-device 7 --stt-delay-ms 240
$env:MISTRAL_LLM_MODEL = 'mistral-small-latest'
npm run daemon
```

Speaker playback can re-enter the microphone. It is therefore rejected unless
echo cancellation is explicitly enabled:

```powershell
npm run daemon -- --audio-profile speaker --echo-cancel
```

The bundled speaker profile compares microphone frames with a rolling 500 ms
downsampled playback reference and suppresses strongly correlated echo. Room
acoustics and device latency still vary; use a headset for the most dependable
barge-in behavior.

## Local control

The daemon owns the per-user named pipe `\\.\pipe\voxtral-daemon`. Frames are
newline-delimited JSON requests/responses; no TCP port is opened. Only one
daemon can bind the pipe.

```powershell
npm run control -- status
npm run control -- say "Hello"
npm run control -- interrupt
npm run control -- stop
```

After `npm link`, the equivalent commands are `voxtral status`, `voxtral say
TEXT`, `voxtral interrupt`, and `voxtral stop`. `stop` requests a clean shutdown
that releases microphone and speaker resources. New control clients receive a
structured `shutting_down` error while shutdown is in progress.

Final assistant events include a structured `citations` array. Search workers
are tagged with `conversationId` and `turnId`; barge-in or a newer turn aborts
and discards stale results. TTS receives citation text without raw URLs.

## Start after Windows login

The installer creates a Windows Scheduled Task under the current user. It does
not copy or print `.env`; the daemon reads the existing project `.env` at run
time. Logs go to `%LOCALAPPDATA%\Voxtral\logs`.

```powershell
npm run service:install -- -StartNow
npm run service:uninstall
```

The task starts after interactive login, prevents duplicate instances, and
retries three times at one-minute intervals after a crash. For recovery, run
`voxtral status`, inspect the redacted logs, then use Task Scheduler to start
`Voxtral Daemon` or run `npm run daemon` in the project directory. Use
`voxtral stop` for a graceful service stop. Uninstall preserves logs unless
`scripts/uninstall-windows-service.ps1 -RemoveLogs` is requested.

Events and errors are JSONL. Secret-shaped fields and the configured Mistral
API key are redacted; raw microphone audio, provider payloads, authorization
headers, and `.env` contents are never logged. Do not add raw provider bodies
to diagnostics.

## Deterministic tests

```powershell
npm test -- test/session.test.mjs test/delegation.test.mjs test/control-ipc.test.mjs
npm test
```

Tests inject audio, search, network, and pipe-facing interfaces; they require no
live microphone, speaker, API key, or search service.

The existing batch tools remain available:

```powershell
npm run tts -- "Hello" --voice-id VOICE_ID --output output.mp3
npm run transcribe -- sample.mp3 --language en
```

Voice cloning must only be used with appropriate consent and in accordance
with Mistral's usage policy.
