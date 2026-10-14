# MeetBot

A terminal meeting recorder and notepad. No bot joins your call and you don't paste a link.

- **Live transcription:** Voicegain real-time Speech Analytics (`POST /sa`, JWT bearer auth).
- **Summaries:** a local model through Ollama. Transcripts are never sent to a third-party LLM.
- **Audio capture:** a small Python sidecar records your mic (left channel) and system audio (right channel) on Windows via WASAPI loopback.
- **Interface:** a TUI with a live transcript, a personal-notes pane and a speaker bar. `--plain` gives a simple line-based mode.

## Setup

1. Install Node 20+ and run `npm install`.
2. Install Python 3 and run `pip install -r sidecar/requirements.txt` (`pyaudiowpatch`, `numpy`).
3. Set your credentials. The JWT is read from the environment or `~/.meetbot/config.json`. It is never logged and is sent only to the Voicegain API.

   ```
   setx VOICEGAIN_JWT "<your jwt>"
   setx VOICEGAIN_SA_CONFIG "<id of an SA config created in the Voicegain console>"
   setx VOICEGAIN_BASE_URL "https://api.voicegain.ai/v1"   # optional, this is the default
   ```
4. Install Ollama and run `ollama pull qwen2.5:7b-instruct`.
5. Run `meetbot doctor` (`npm start -- doctor`). It checks Node, the sidecar, audio devices, the JWT, the Voicegain endpoint and Ollama.
6. Optional: `meetbot probe --seconds 10` opens a real session and saves the raw websocket messages to `~/.meetbot/probe-*.jsonl`. Send me that file if the live transcript looks wrong.

## Usage

```
meetbot                                  # open the TUI, press Enter to start
meetbot --title "Q3 planning" --preset team --template standup -y
meetbot --ics invite.ics                 # attendees and title from a calendar invite
meetbot summarize <meeting-folder> [--template name]   # re-run the summary
meetbot templates | presets | devices | doctor | probe
```

Useful options: `--me <name>`, `--room` (everyone is in one room on the mic), `--no-system`, `--no-mic`, `--out <dir>`, `--no-summary`, `--plain`.

### In the TUI

| | |
|---|---|
| Notes | Type text and press Enter. `/a` action, `/d` decision, `/q` question, `/f` flag this moment. |
| Control | `Ctrl+P` pause/resume, `/stop` or `Ctrl+C` twice to stop and save, `/reconnect`, `/status`, `/open`. |
| Speakers | `Tab`/`Shift+Tab` or `Alt+1..9` select who is speaking on the remote side. `/speaker`, `/relabel` (fix the last line), `/add A, B`, `/rm`, `/me`, `/mode call\|room`, `/name Speaker 2 Priya`. |
| Presets | `/preset save\|load\|list\|rm <name>`. Presets are stored in `~/.meetbot/presets`. |
| Misc | `/title`, `/template`, `/hint <word>` (ASR hint), `/ics <file>`, `/help`. |

## Speaker labels

- Your mic is channel 0, so it is always you.
- The remote channel uses a roster you maintain with a hotkey timeline, applied with a 1 s lag. If Voicegain diarization is enabled and returns speakers, they appear as "Speaker N" and can be renamed with `/name`.
- Screenshot-based speaker detection is not implemented yet.

## Output

```
Documents/MeetBot/2026-10-14_13-30-37/
  transcript.md
  personal-notes.md
  summary.md
  .data/   raw websocket log, events and notes (used by `meetbot summarize` and crash recovery)
```

## Templates

Templates are Markdown files in `templates/` or `~/.meetbot/templates/`. Select one with `--template name`.

- Built-in slots: `{{title}} {{date}} {{time}} {{duration}} {{participants}} {{personal_notes}}`.
- AI slots: `{{ai:key|instruction for the model}}`.
- If a slot is named `actions`, `decisions` or `questions`, your `/a`, `/d` and `/q` notes are always included.
- Included templates: `general-meeting`, `one-on-one`, `standup`.

## Privacy

- Audio is streamed to Voicegain for transcription. Summarization stays on your machine.
- While paused, nothing is captured or sent.
- If your Documents folder is synced by OneDrive, the saved files are synced too.

## Known limitations

- The Windows audio capture and the live Voicegain API were not tested here. Everything else was tested against mocks that follow your two OpenAPI specs: 25 automated tests (`npm test`) plus a pseudo-terminal check of the TUI.
- The mic channel is sent with `isAgent` set. Diarization on stereo audio is unverified.
- Voicegain analytics events are ignored; only transcript data is used.
