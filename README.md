# Voxtral Live

**Voxtral Live** is an experimental, local-first Windows voice assistant runtime built around Mistral audio services. It is inspired by the always-available interaction style of modern live voice assistants; it is an independent project and is not affiliated with, endorsed by, or made by OpenAI or Mistral AI.

The product runtime is a headless Node.js daemon. It is designed to listen and respond through your system devices without keeping a browser window open. A small browser app remains in the source tree only as a development harness and is intentionally not published with this repository.

## What works today

- Headless daemon startup with a stable JSON Lines event stream.
- `always-on` and `push-to-talk` runtime modes.
- A Windows system-audio backend through PortAudio/`naudiodon2`, with selectable input and output device IDs.
- A tested realtime Voxtral transcription WebSocket adapter for 16 kHz PCM audio, including partial and final transcript events.
- Voice activity detection and a cancellable playback queue as separate building blocks for barge-in behavior.
- Command-line batch transcription and text-to-speech, including saved voice IDs, consent-based reference-audio voice cloning, and MP3/WAV/FLAC/Opus/PCM output.
- A test suite that uses local fakes and does not spend API credits.

## Windows behavior

`npm run daemon` runs in the terminal with no web UI and no HTTP listener. It prints one redacted JSON object per line to stdout, beginning with `daemon_started` and `listening`. Stop it with `Ctrl+C` to receive `daemon_stopped`.

Use a headset while developing barge-in flows. Speaker-mode echo cancellation is not implemented yet, so it is not a reliable hands-free experience.

## Setup

1. Install Node.js 20.6 or newer on Windows.
2. Clone this repository and install dependencies.

   ```powershell
   npm install
   ```

3. Copy the example environment file.

   ```powershell
   Copy-Item .env.example .env
   ```

4. Set your Mistral API key in `.env`.

   ```dotenv
   MISTRAL_API_KEY=your_mistral_api_key
   # Optional: use a compatible Mistral API proxy or regional endpoint.
   # MISTRAL_BASE_URL=https://api.mistral.ai
   ```

`MISTRAL_API_KEY` is required. Keep `.env` private: it is ignored by Git and must never be committed.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run daemon` | Start the headless daemon in `always-on` mode. |
| `npm run daemon -- --mode push-to-talk` | Start the daemon in push-to-talk mode. |
| `npm run daemon -- --once` | Emit startup events once, then exit; useful for smoke tests. |
| `npm run control -- status` | Reserved for future local IPC; currently returns a structured not-implemented event. |
| `npm run tts -- "Hello" --voice-id VOICE_ID --output output.wav` | Generate speech from text. |
| `npm run tts -- "Hello" --ref-audio sample.wav --output output.mp3` | Generate speech from a consented reference clip. |
| `npm run transcribe -- recording.wav --language en` | Batch-transcribe a local audio file. |
| `npm test` | Run the local test suite. |
| `npm run dev` | Run the private browser development harness; it is not part of the headless product. |

## Security and redaction

- The API key stays in the local daemon process; it is never sent to a browser.
- JSONL events redact fields whose names look like credentials (`apiKey`, `authorization`, `token`, `secret`, and similar) and redact occurrences of the active Mistral key from string values.
- The daemon event contract intentionally excludes raw microphone audio and full provider payloads.
- Treat transcripts and reference audio as sensitive data. This project does not yet provide encrypted storage, OS credential-vault integration, or a retention policy.
- Use voice cloning only with the speaker's clear consent and in accordance with your provider's policies.

## Architecture

```text
System microphone / speakers
          |
  PortAudio audio backend
          |
 VAD + playback queue          Realtime STT adapter
          |                            |
          +------ future session / turn engine ------+
                                                       |
                                         Mistral LLM + TTS adapters
```

The code keeps the pieces separate so native audio, realtime transcription, playback interruption, and provider APIs can evolve independently. The rationale for the headless design is recorded in [ADR-001](docs/decisions/ADR-001-headless-background-daemon.md).

## Testing

Run the full suite with:

```powershell
npm test
```

Coverage includes the daemon contract, config validation, event redaction, realtime transcription protocol handling, VAD, playback queue, PortAudio adapter behavior, and the local development server. Tests mock network and native boundaries where practical; they do not validate live API credentials, installed audio hardware, or end-to-end conversations.

## Roadmap and current limitations

The repository has the foundational pieces, not a finished conversational assistant.

1. Wire the audio backend, VAD, realtime transcription, LLM, and TTS adapters into one long-lived turn/session engine.
2. Add local named-pipe IPC for status, speak, interrupt, and shutdown controls.
3. Implement robust barge-in cancellation, reconnection, and error recovery.
4. Add Windows startup/packaging, device discovery, and diagnostics.
5. Establish an echo-cancelled speaker-mode profile and validate on real hardware.

Until those steps are complete, the daemon currently emits lifecycle events only; it does not continuously capture audio or conduct live conversations.
