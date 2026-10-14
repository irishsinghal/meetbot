# MeetBot

A terminal meeting recorder and notepad. No bot joins your call and you don't paste a link.

- **Live transcription:** Voicegain real-time Speech Analytics (`POST /sa`, JWT bearer auth).
- **Summaries:** a local model through Ollama. Transcripts are never sent to a third-party LLM.
- **Audio capture:** a small Python sidecar records your mic (left channel) and system audio (right channel) on Windows via WASAPI loopback.
- **Interface:** a TUI with a live transcript, a personal-notes pane and a speaker bar. `--plain` gives a simple line-based mode.

## Setup

Quick path: install Node 20+, Python 3 and Ollama, run `npm install`, then `meetbot setup` (`npm start -- setup`). The wizard saves your settings to `~/.meetbot/config.json`, installs the Python packages, pulls the Ollama model and runs `doctor`. Pass `--jwt`, `--sa-config`, `--me`, `--out`, `--model` to skip prompts, `-y` to run non-interactively, and `--skip-install` to only print the install commands. The manual steps follow.

1. Install Node 20+ and run `npm install`. To use the `meetbot` command from any folder, run `npm link` once in the repo (open a new terminal afterwards; if it is still not found, add the folder printed by `npm prefix -g` to your PATH). Without it, use `npm start -- <args>` or `node bin/meetbot.js <args>` wherever this README says `meetbot <args>`.
2. Install Python 3 and install `sidecar/requirements.txt` (`pyaudiowpatch`, `numpy`), preferably in a virtual environment. MeetBot uses `capture.python` from `config.json` / `MEETBOT_PYTHON` if set, otherwise an active venv (`VIRTUAL_ENV`), then `.venv` or `venv` in the repo, then `~/.meetbot/venv`. `meetbot setup` creates `~/.meetbot/venv` for you if none exists.
3. Set your credentials. The JWT is read from the environment or `~/.meetbot/config.json`. It is never logged and is sent only to the Voicegain API.

   ```
   setx VOICEGAIN_JWT "<your jwt>"
   setx VOICEGAIN_SA_CONFIG "<id of an SA config created in the Voicegain console>"
   setx VOICEGAIN_BASE_URL "https://api.ascalon.ai/v1"   # optional, this is the default
   ```
   Instead of environment variables you can create `~/.meetbot/config.json` (on Windows `C:\Users\<you>\.meetbot\config.json`; set `MEETBOT_HOME` to use another folder). It is plain JSON, you only need the keys you want to change, and they are merged over the defaults. Precedence is defaults < `config.json` < environment variables < command-line flags.

   ```json
   {
     "me": "Rishabh",
     "outputDir": "D:\\Meetings",
     "template": "standup",
     "voicegain": {
       "jwt": "<your jwt>",
       "saConfig": "<SA config id>",
       "language": "en-us",
       "diarization": true
     },
     "llm": { "model": "qwen2.5:7b-instruct", "url": "http://127.0.0.1:11434" },
     "capture": { "python": "C:\\Python313\\python.exe" }
   }
   ```

   Backslashes in Windows paths must be doubled (or use forward slashes). Putting the JWT in this file stores it in plain text, so prefer `VOICEGAIN_JWT`. See `defaults()` in `src/config.js` for every available key.
4. Install Ollama and run `ollama pull qwen2.5:7b-instruct`.
5. Run `meetbot doctor` (`npm start -- doctor`). It checks Node, the sidecar, audio devices, the JWT, the Voicegain endpoint and Ollama.
6. Optional: `meetbot probe --seconds 10` opens a real session and saves the raw websocket messages to `~/.meetbot/probe-*.jsonl`. Send me that file if the live transcript looks wrong.

## Usage

```
meetbot                                  # open the TUI, press Enter to start
meetbot --title "Q3 planning" --preset team --template standup -y
meetbot --ics invite.ics                 # attendees and title from a calendar invite
meetbot summarize <meeting-folder> [--template name]   # re-run the summary
meetbot templates | presets | devices | layout | doctor | probe
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

## Live help during a call

- **Catch me up** (button, `Ctrl+K`, or `/catchup [minutes]`): the local model summarizes the last few minutes (default 5) and tells you if anyone asked or assigned something to you.
- **Tagged alerts**: when someone else says your name (first name, full name, or aliases in `mentions.names` in `config.json`), a banner shows who said it and, after a few seconds, why (what they want from you). It is also saved as a Flag note. Turn off with `"mentions": {"enabled": false}`.

## Cleaner transcripts (optional, recommended)

`meetbot setup` asks whether to keep each call's audio locally and re-transcribe it after the call with local Whisper (faster-whisper, `small.en`). Speakers still come from the live results: every Whisper word takes the speaker of the live line it overlaps on the same channel. The recording is **deleted once the new transcript is written**; if the local pass fails it is kept and `meetbot retranscribe <folder>` retries it.

- It is a config setting (`recording.enabled`), not a command-line flag. In the app, the **Record audio** checkbox (or `/record on|off`) switches it for the next call before you press Start.
- Cost: about 115 MB of disk per hour while the call runs, and CPU time after the call (roughly real time for `small.en` on a laptop CPU).
- The recording contains the other participants' voices; it never leaves your machine.

## Speaker labels

- Your mic is channel 0, so it is always you.
- The remote channel uses a roster you maintain with a hotkey timeline, applied with a 1 s lag. If Voicegain diarization is enabled and returns speakers, they appear as "Speaker N" and can be renamed with `/name`.
- Screenshot-based speaker detection is not implemented yet.

## Output

```
Documents/MeetBot/2026-10-14/13-30-37/      (default "day" layout)
  transcript.md
  personal-notes.md
  summary.md
  .data/   raw websocket log, events and notes (used by `meetbot summarize` and crash recovery)
```

### Folder layout

`folderLayout` in `config.json` (or `MEETBOT_LAYOUT`) controls how meetings are grouped:

| Layout | Example |
|---|---|
| `day` (default) | `2026-10-14/13-30-37` - one folder per day |
| `nested` | `2026/10/14/13-30-37` - year / month / day, for long archives |
| `flat` | `2026-10-14_13-30-37` - the original single level |

Change it any time with `meetbot layout` (prompts), `meetbot layout nested`, or via `meetbot setup`. It then lists the existing meetings that are not in the new layout and asks whether to move them; use `--migrate` or `--no-migrate` to skip the question. Meetings are found by their `.data/meeting.json` and placed by their recorded start time, so folders you move yourself are fine. Meeting folders are only moved, never rewritten.

## Templates

Templates are Markdown files in `templates/` or `~/.meetbot/templates/`. Select one with `--template name`.

- Built-in slots: `{{title}} {{date}} {{time}} {{duration}} {{participants}} {{personal_notes}}`.
- AI slots: `{{ai:key|instruction for the model}}`.
- If a slot is named `actions`, `decisions` or `questions`, your `/a`, `/d` and `/q` notes are always included.
- Included templates: `general-meeting`, `one-on-one`, `standup`, `voice-note`.
- The default is `auto`: if (almost) all the speech is yours (a voice note or thinking out loud) it uses `voice-note`, otherwise `general-meeting`. `meetbot note` starts recording straight away for quick capture; the speaker row only appears once someone else is on the line or you add people.

## Privacy

- Audio is streamed to Voicegain for transcription. Summarization stays on your machine.
- While paused, nothing is captured or sent.
- If your Documents folder is synced by OneDrive, the saved files are synced too.

## Known limitations

- The Windows audio capture and the live Voicegain API were not tested here. Everything else was tested against mocks that follow your two OpenAPI specs: 25 automated tests (`npm test`) plus a pseudo-terminal check of the TUI.
- The mic channel is sent with `isAgent` set. Diarization on stereo audio is unverified.
- Voicegain analytics events are ignored; only transcript data is used.
