# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MeetBot: a terminal meeting recorder + notepad (Node 20+, ESM, Ink/React TUI via `htm`). Live transcription via Voicegain `/sa` websocket, summaries via local Ollama, audio capture via a Python sidecar (Windows WASAPI). See `README.md` for user-facing setup, CLI flags and TUI slash commands.

## Commands

- `npm install`; `pip install -r sidecar/requirements.txt` (sidecar only)
- `npm start -- [args]` (= `node bin/meetbot.js`); subcommands: `doctor`, `probe`, `devices`, `templates`, `presets`, `summarize <folder>`; `--plain` for the non-TUI mode
- `npm test` runs all of `test/*.test.js` with `node --test`. Single file: `node --test --test-force-exit test/unit.test.js`; single test: add `--test-name-pattern="<name>"`.
- Manual testing without real services: `node test/helpers/serve-mocks.js` starts mock Voicegain + Ollama and prints the env vars (`VOICEGAIN_BASE_URL`, `VOICEGAIN_JWT`, `VOICEGAIN_SA_CONFIG`, `OLLAMA_URL`) to point MeetBot at them. `python sidecar/capture.py --selftest 5` emits synthetic audio without devices.
- No linter or build step is configured.

## Architecture

Data flow: **sidecar → `audio/source.js` → `MeetingSession` → `voicegain/client.js` → `TranscriptBuilder` → files + `summarize/`**.

- `sidecar/capture.py` writes raw interleaved stereo PCM (16 kHz, int16, L = mic, R = system audio) to stdout in 100 ms wall-clock frames; stderr carries JSON status lines; it exits when stdin closes. `src/audio/source.js` spawns it and re-chunks into exactly 6400-byte frames (`FRAME_BYTES`). Alternative sources (WAV file, used by tests) emit the same frames.
- `src/session.js` (`MeetingSession`, an EventEmitter) is the core. It owns state (`ready|recording|paused|stopping|done`), the audio clock (derived from bytes sent, `BYTES_PER_SEC`, not wall time), a bounded frame queue with retry/backoff while Voicegain is unreachable, notes, and the speaker book. On stop it writes `transcript.md`, `personal-notes.md`, `summary.md`. All collaborators (source, Voicegain session/link, summarizer, fetch, clock) are injected via `deps` so tests substitute mocks.
- `src/voicegain/`: `client.js` (REST session creation + websocket link), `parse.js`/`transcript.js` (turn websocket messages into transcript lines, split by `lineGapMs`, per channel).
- `src/speakers.js`: `SpeakerBook`. Channel 0 is always "me"; the remote channel's speaker comes from a user-maintained roster/hotkey timeline applied with a lag, or from Voicegain diarization ("Speaker N", renamable).
- `src/summarize/`: Ollama client plus a template engine. Templates (`templates/*.md`, overridable in `~/.meetbot/templates`) have built-in slots `{{title}}` etc. and AI slots `{{ai:key|instruction}}`; `/a /d /q` notes are forced into slots named `actions`/`decisions`/`questions`. `fallbackSummary` is used when the LLM is unavailable.
- Crash recovery: each meeting folder (`storage.js`, under `Documents/MeetBot/`, path shaped by `cfg.folderLayout`: `flat|day|nested`; `meetbot layout` / `layout.js` switches and migrates) has a `.data/` dir with raw websocket log, `events.jsonl` (timestamped by audio clock) and `notes.jsonl`. `meetbot summarize` and `recover.js` rebuild outputs from it, so any new session state that affects output must also be written as an event.
- `src/web/` is the default UI (`meetbot` opens a browser page): `server.js` serves `index.html` on 127.0.0.1 (random token in the URL, Origin check) and mirrors the session over a websocket; typed lines go through `runCommand`. The Ink TUI (`--tui`) and `--plain` remain.
- `src/errlog.js` writes `~/.meetbot/logs/meetbot.log` (session logs, uncaught errors, signals); on SIGINT/SIGTERM/SIGHUP `bin/meetbot.js` stops and saves a running meeting.
- `src/refine.js` + `sidecar/transcribe.py`: optional post-call local Whisper pass over `.data/audio.pcm` (kept only when `session.recordAudio`, switched per call before start; config `recording.enabled`). Speakers come from the live lines (`mergeWords`); the recording is deleted after success, kept on failure for `meetbot retranscribe`.
- Stopping is two-phase (`session._finalize` / `_improve`): files + a draft summary are written at once and the state is `done`; the Whisper pass and model summary then replace them in the background (`session.whenFinalized()`, `finalizing`, 'finalized' event). Callers that exit must await it.
- `src/catchup.js`: `/catchup` recap and tagged-by-name alerts (`session._watchMentions`), local model only.
- `src/commands.js` is the slash-command parser shared by `tui/app.js` (Ink) and `tui/plain.js`; add new commands there so both modes get them.
- `src/config.js`: config merges defaults, `~/.meetbot/config.json` (home overridable with `MEETBOT_HOME`), then env vars (`VOICEGAIN_*`, `OLLAMA_URL`, `MEETBOT_*`). `redact()` strips the JWT from anything logged; route log text through `session.log`.

## Conventions

- Session code must never crash a meeting on I/O failure (disk full, network): errors are swallowed/logged, not thrown (see `_event`/`_save`).
- The real Windows audio capture and live Voicegain API are untested; mocks in `test/helpers/` follow the Voicegain OpenAPI specs, so keep them in sync with `voicegain/` changes.
