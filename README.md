# Mistral Voxtral

The primary runtime is a headless Voxtral daemon. The existing browser UI is
kept as a development harness for the batch TTS and transcription adapters.

## Setup

Create a private `.env` file with these exact keys:

```dotenv
MISTRAL_API_KEY=your-key
VOXTRAL_MODE=always-on
MISTRAL_STT_MODEL=voxtral-mini-transcribe-realtime-2602
MISTRAL_LLM_MODEL=mistral-small-latest
MISTRAL_TTS_MODEL=voxtral-mini-tts-latest
MISTRAL_VOICE_ID=optional-voice-id
```

`MISTRAL_API_KEY` is required and empty values are rejected. `VOXTRAL_MODE`
may be `always-on` (the default) or `push-to-talk`; `--mode` on the command
line overrides the environment value. Keep `.env` private; it is excluded by
`.gitignore`.

## Headless daemon

Start the daemon with:

```powershell
npm run daemon
npm run daemon -- --mode push-to-talk
```

The daemon emits one JSON object per line (JSONL) to stdout. Initial events
are `daemon_started` with `sessionId` and `mode`, followed by `listening` with
`sessionId`. Future control and audio layers extend this event stream with
turn and error events. Events never include the API key, raw microphone audio,
or full provider payloads.

The `control` command is reserved for the local IPC control layer. In Task 1
it exits with a structured `control_not_implemented` error; it does not start
another daemon. IPC commands are added in Task 8:

```powershell
npm run control -- status
```

```powershell
npm run tts -- "Ahoj, tohle mluví Voxtral." --voice-id VOICE_ID
```

## Generate speech

Use a preset or saved custom voice ID:

```powershell
npm run tts -- "Ahoj, tohle mluví Voxtral." --voice-id VOICE_ID --output output.mp3
```

Or provide a short reference clip for one-off voice cloning:

```powershell
npm run tts -- "Ahoj, tohle mluví Voxtral." --ref-audio sample.mp3 --output output.mp3
```

Supported output formats are `mp3`, `wav`, `flac`, `opus`, and `pcm`.

## Transcribe audio

Transcribe a local audio file with Voxtral Mini Transcribe 2:

```powershell
npm run transcribe -- sample.mp3 --language en
```

The current prototype uses the batch transcription endpoint and prints the
result to the terminal. Realtime microphone transcription is the next layer.

## Test

```powershell
npm test
```

The tests use a local fake HTTP response and do not spend API credits.

Voice cloning must only be used with appropriate consent and in accordance
with Mistral's usage policy.

## Launch the product

Start the local web app:

```powershell
npm run dev
```

Open [http://localhost:4317](http://localhost:4317). The app automatically
loads the voices available to the API key. No key is sent to the browser.

The current product MVP supports:

- preset and saved voice selection
- one-off voice cloning from a short audio reference
- MP3, WAV, FLAC, and OPUS speech output
- local audio upload and batch transcription
- browser playback, download, and transcript copy

Realtime microphone transcription and full conversational barge-in are the
next product layer; the API adapters are kept separate so they can be added
without replacing this UI.
