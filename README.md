# Voxtral Live

Voxtral Live is a headless Windows voice daemon: microphone PCM streams to
Voxtral Realtime STT, completed turns stream through Mistral chat, and
sentence-sized output streams through Voxtral TTS to the selected speaker.
Local VAD can cancel active LLM/TTS work for barge-in. It is inspired by GPT
Live 1, but is independent and not affiliated with OpenAI.

Normal operation needs no browser window and opens no network listener. The
files under `public/` are a development harness only.

## Windows setup

1. Install Node.js 20.6 or newer and run `npm install`.
2. Copy `.env.example` to a private `.env`; never commit it.
3. Set the required key and, if needed, model overrides.
4. Start with a headset profile: `npm run daemon`.

```dotenv
MISTRAL_API_KEY=your-key
VOXTRAL_MODE=always-on
MISTRAL_STT_MODEL=voxtral-mini-transcribe-realtime-2602
MISTRAL_LLM_MODEL=mistral-small-latest
MISTRAL_TTS_MODEL=voxtral-mini-tts-latest
# Optional override; defaults to Paul - Neutral (preset c69964a6-ab8b-4f8a-9465-ec0925096ec8).
# MISTRAL_VOICE_ID=optional-voice-id
```

`MISTRAL_API_KEY` is required. `VOXTRAL_MODE` accepts `always-on` (default) or
`push-to-talk`. `VOXTRAL_SEARCH_ENDPOINT` is optional and must be an
application-owned JSON endpoint accepting `{ "query": string, "recencyDays"?:
number }`; it may return only normalized `title`, `url`, `snippet`, and
`publishedAt` fields.

## Commands and devices

```powershell
npm run daemon
npm run daemon -- --mode push-to-talk --input-device 13 --output-device 19
npm run daemon -- --stt-delay-ms 240
npm run daemon -- --audio-profile speaker --echo-cancel
```

Device IDs are machine-specific. List PortAudio devices before selecting them:

```powershell
node -e "console.log(require('naudiodon2').getDevices())"
```

Headset mode is the supported default. Speaker mode is rejected unless
`--echo-cancel` is supplied; its rolling-reference suppressor is not a full
acoustic echo canceller and needs device-specific validation.

Model selection is environment-driven. Set `MISTRAL_STT_MODEL`,
`MISTRAL_LLM_MODEL`, or `MISTRAL_TTS_MODEL` in `.env` (or the process
environment) and restart the daemon. When `MISTRAL_VOICE_ID` is absent, the
daemon uses its configurable Paul - Neutral preset
(`c69964a6-ab8b-4f8a-9465-ec0925096ec8`); setting the variable overrides that
default. This preset is a Mistral configuration choice, not an official
affiliation or endorsement.

## Local IPC and service lifecycle

The daemon owns one SID-qualified, per-user named pipe such as
`\\.\pipe\voxtral-daemon-S-1-5-21-...`. Requests and responses are
newline-delimited JSON; no TCP port is opened.

```powershell
npm run control -- status
npm run control -- say "Hello"
npm run control -- interrupt
npm run control -- stop
```

After `npm link`, the equivalent commands are `voxtral status`, `voxtral say
TEXT`, `voxtral interrupt`, and `voxtral stop`. `stop` waits for clean session,
microphone, and speaker cleanup. New requests receive a structured
`shutting_down` error once shutdown begins.

Install the login-start Scheduled Task only on a target machine:

```powershell
npm run service:install -- -StartNow
npm run service:uninstall
```

It runs under the current user after interactive login, prevents duplicates,
retries three times at one-minute intervals after a crash, and writes logs to
`%LOCALAPPDATA%\Voxtral\logs`. It does not copy, print, or persist `.env`.
For recovery, run `voxtral status`, inspect redacted logs, then start
`Voxtral Daemon` in Task Scheduler or run `npm run daemon` directly.

## Privacy and architecture

Events and errors are JSONL. The configured API key and secret-shaped fields
are redacted; raw microphone audio, provider payloads, authorization headers,
and `.env` contents must never be logged. Do not add raw provider bodies to
diagnostics.

```text
PortAudio input -> VAD/session -> Realtime STT -> streaming chat -> sentence queue -> streaming TTS -> PortAudio output
                         |              |               |
                         +-- generation/AbortController +-- local named-pipe control
```

The session assigns every turn a `turnId` and `generationId`; stale work is
discarded after barge-in. Search jobs carry the same identities, return
structured citations, and omit raw URLs from TTS-facing text. The architectural
rationale is in [ADR-001](docs/decisions/ADR-001-headless-background-daemon.md).

## Testing

```powershell
npm test
npm test -- test/providers-mistral.test.mjs test/tts-stream.test.mjs
```

Tests inject audio, search, provider/network, and pipe interfaces, so they do
not need a live microphone, speaker, API key, or browser. The fragmented SSE
fixture at `test/fixtures/tts-stream-events.ndjson` is consumed by the TTS
stream parser test to guard arbitrary event-boundary handling.

The existing batch tools remain available:

```powershell
npm run tts -- "Hello" --voice-id VOICE_ID --output output.mp3
npm run transcribe -- sample.mp3 --language en
```

## Limitations

- Czech is unsupported by the default Mistral speech profile and is not
  production-ready. Use a separately validated Czech STT/TTS provider before
  offering Czech conversations.
- A headset is the reliable barge-in configuration. Speaker-mode thresholds,
  driver buffering, and echo behavior require per-device tuning.
- Live model availability and credentials remain provider-dependent. See
  [Task 9 handoff](docs/task-9-verification-handoff.md) for the recorded live
  checks and unverified scenarios.
- Voice cloning requires appropriate consent and compliance with Mistral's
  usage policy.
