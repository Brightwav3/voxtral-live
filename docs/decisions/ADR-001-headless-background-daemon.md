# ADR-001: Use a headless background daemon for Voxtral Live

## Status

Accepted

## Date

2026-08-11

## Context

Voxtral Live must behave like a voice service running in the background, not
like a browser application. A user should speak through the system microphone
and hear replies through the system speakers without opening a web page. The
product is inspired by GPT Live 1 but is independent and not affiliated with
OpenAI. It needs low-latency barge-in, local control, and a safe place for the
long-lived Mistral API key.

The repository contains a browser UI MVP and batch TTS/transcription adapters.
The UI is useful for API smoke tests, but it is not the product runtime.

## Decision

Build Voxtral Live as a Node.js headless daemon with five isolated layers:

1. Native audio input/output behind an `AudioBackend` interface.
2. Local VAD and playback queue for fast interruption behavior.
3. Mistral Voxtral Realtime STT, a streaming Mistral LLM, and Voxtral TTS adapters.
4. A turn/session state machine with generation IDs and `AbortController` cancellation.
5. Local named-pipe IPC and a CLI for status, explicit speech, interruption, and shutdown.

The first Windows backend uses `naudiodon2`/PortAudio. It is an implementation
detail behind the audio interface; a Rust/CPAL worker can replace it later if
native packaging or echo cancellation requires it.

The daemon reads its API key from `.env` directly. Browser short-lived client
tokens are not needed because the product has no browser client. The key is
never emitted through events or logs. Control is a SID-qualified per-user
Windows named pipe with newline-delimited JSON, not a TCP/HTTP server.

## Alternatives considered

### Browser UI plus local HTTP server

- Pros: easy microphone permissions and rapid visual debugging.
- Cons: violates the headless product requirement, adds a browser lifecycle,
  and makes automatic background startup awkward.
- Rejected: keep only as a temporary development harness.

### Windows service that exposes an HTTP control port

- Pros: simple integrations for command-line and monitoring clients.
- Cons: opens a network-facing surface, adds authentication and firewall
  requirements, and weakens the single-user desktop security boundary.
- Rejected: use a per-user named pipe and CLI instead.

### Python process with PyAudio

- Pros: Mistral's realtime examples show a direct microphone path with PyAudio.
- Cons: requires a Python runtime and native audio installation in the
  end-user environment.
- Rejected for the first commercial packaging target: the current product is
  Node-based and should install from one runtime.

### Rust/CPAL as the complete product

- Pros: strong native audio and packaging story.
- Cons: duplicates the current Node API/orchestration work and increases the
  first implementation surface.
- Deferred: keep the audio boundary ready for a Rust worker if PortAudio
  packaging fails.

### Direct provider-to-provider speech loop with no session engine

- Pros: fewer files initially.
- Cons: makes stale results, barge-in cancellation, tools, and background
  delegation unreliable.
- Rejected: explicit session state and generation IDs are required for correct
  interruption behavior.

## Consequences

- The product can start at login and operate without a UI or open port.
- The long-lived API key stays on the local machine and never enters a browser context.
- Audio-device compatibility becomes a first-class test requirement.
- Headset mode must be the first reliable barge-in profile; speaker mode needs
  echo cancellation before it can be marketed as robust.
- The existing `public/` UI must remain clearly marked as a test harness so
  future contributors do not treat it as the product architecture.
- Czech is unsupported by the default speech profile and must not be presented
  as production-ready until a separately validated provider is available.
