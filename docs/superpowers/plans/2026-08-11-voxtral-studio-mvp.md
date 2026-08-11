# Voxtral Studio MVP Implementation Plan

> **Superseded:** The final product is headless. Use `2026-08-11-voxtral-headless-daemon-handoff.md` as the implementation source of truth. This document describes the disposable browser test harness only.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current CLI prototype into a local-first web product that works after entering a Mistral API key, with voice discovery, text-to-speech, audio transcription, playback, downloads, and clear errors.

**Architecture:** A Node.js HTTP server keeps the Mistral API key server-side and exposes small app endpoints. A static browser UI calls those endpoints, renders saved/preset voices, uploads audio, and plays generated audio. The API adapter layer remains separate from the UI so realtime audio can be added later without replacing the product shell.

**Tech Stack:** Node.js 20+, built-in `http`, `fetch`, `FormData`, `Blob`, vanilla HTML/CSS/JavaScript, Node test runner.

## Global Constraints

- API key is read from `.env` and never returned to browser code or logs.
- Existing `npm test`, `npm run tts`, and `npm run transcribe` behavior must remain valid.
- No frontend dependency is required for the first product shell.
- TDD is required for new server behavior.
- The first product is batch transcription; realtime microphone streaming remains a separate next milestone.

### Task 1: Product server contract

**Files:**
- Create: `src/server.mjs`
- Create: `test/server.test.mjs`
- Modify: `package.json`

**Interfaces:**
- `GET /api/health` returns `{ "ok": true }`.
- `GET /api/voices` returns Mistral voice metadata.
- `POST /api/tts` accepts JSON `{ text, voiceId, format }` and returns audio bytes.
- `POST /api/transcribe` accepts multipart audio and returns `{ text }`.
- `GET /` serves `public/index.html`.

- [ ] Write failing tests for health, voice listing, and JSON TTS routing.
- [ ] Run `npm test` and confirm the server module is missing.
- [ ] Implement the minimal HTTP server and API routing with injected `fetch`.
- [ ] Run server tests and the existing test suite.

### Task 2: Product UI

**Files:**
- Create: `public/index.html`
- Create: `public/app.js`
- Create: `public/styles.css`

**Interfaces:**
- Voice selector is populated from `/api/voices`.
- Generate action calls `/api/tts` and attaches the returned Blob to an audio player.
- Transcribe action sends a selected audio file to `/api/transcribe` and renders the returned text.
- Status and error areas are always updated with user-facing messages.

- [ ] Build the responsive shell with the chosen visual direction: dark audio-workbench canvas, warm paper text panels, and a single cyan signal accent.
- [ ] Add voice selection, text input, format selection, audio output, and download controls.
- [ ] Add audio upload, language selection, transcript output, and copy control.
- [ ] Add reduced-motion support and visible keyboard focus styles.

### Task 3: Product startup and documentation

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `.gitignore`

- [ ] Add `npm run dev` to start the local app.
- [ ] Document `http://localhost:4317` and the one-key setup flow.
- [ ] Ignore generated product output and local runtime artifacts.

### Task 4: Verification

- [ ] Run all unit tests.
- [ ] Start the server and call `/api/health`.
- [ ] Run real TTS through the server using `.env`.
- [ ] Run real transcription against generated audio.
- [ ] Check the generated files and report exact results.
