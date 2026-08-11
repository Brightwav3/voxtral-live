# Mistral Voxtral TTS

Voxtral Studio is a local-first voice workbench for Mistral's Voxtral models.
It keeps your API key on the Node server and gives you a browser UI for voice
generation, voice selection, voice cloning, and audio transcription.

## Setup

1. Open `.env`.
2. Put your Mistral API key after `MISTRAL_API_KEY=`.
3. Keep `.env` private; it is excluded by `.gitignore`.

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
