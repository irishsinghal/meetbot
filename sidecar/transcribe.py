#!/usr/bin/env python3
"""MeetBot post-meeting transcription sidecar (local Whisper via faster-whisper).

Reads the raw stereo recording MeetBot kept during a call (16 kHz, signed 16-bit little-endian, interleaved,
LEFT = microphone, RIGHT = system audio), transcribes each channel on its own and prints one JSON line per
Whisper segment to stdout:

    {"chn": 0, "words": [{"w": "Hello,", "s": 1.2, "e": 1.5, "p": 0.93}, ...]}

stderr carries JSON status lines ({"type": "progress", "pct": 0.4}, {"type": "error", ...}).

  python transcribe.py --check                       exit 0 if faster-whisper is importable
  python transcribe.py --prefetch --model small.en   download the model, then exit
  python transcribe.py --audio rec.pcm --model small.en [--language en] [--prompt "Names, jargon"]
"""
import argparse
import json
import sys

SR = 16000


def log(**kw):
    sys.stderr.write(json.dumps(kw) + "\n")
    sys.stderr.flush()


def load_model(name, threads):
    from faster_whisper import WhisperModel
    return WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=threads)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--prefetch", action="store_true")
    ap.add_argument("--audio")
    ap.add_argument("--model", default="small.en")
    ap.add_argument("--language", default="en")
    ap.add_argument("--prompt", default="")
    ap.add_argument("--threads", type=int, default=0, help="0 = library default")
    a = ap.parse_args()

    try:
        import faster_whisper  # noqa: F401
        import numpy as np
    except ImportError as e:
        log(type="error", code="missing", message=f"{e}. Run: pip install faster-whisper")
        return 2
    if a.check:
        print(json.dumps({"ok": True}))
        return 0
    if a.prefetch:
        load_model(a.model, a.threads)
        print(json.dumps({"ok": True, "model": a.model}))
        return 0
    if not a.audio:
        ap.error("--audio is required")

    raw = np.memmap(a.audio, dtype="<i2", mode="r")
    frames = len(raw) // 2
    if frames == 0:
        print(json.dumps({"done": True, "words": 0}))
        return 0
    stereo = raw[: frames * 2].reshape(-1, 2)
    model = load_model(a.model, a.threads)
    total = frames / SR
    channels = []
    for c in (0, 1):
        x = stereo[:, c].astype(np.float32) / 32768.0
        if float(np.sqrt(np.mean(x[:: SR // 10] ** 2))) > 1e-4:  # skip an all-silent channel
            channels.append((c, x))
    lang = a.language if not a.model.endswith(".en") else "en"
    done_audio = 0.0
    span = total * max(1, len(channels))
    n_words = 0
    for c, x in channels:
        segs, _ = model.transcribe(
            x, language=lang, word_timestamps=True, vad_filter=True, beam_size=1,
            initial_prompt=a.prompt or None, condition_on_previous_text=False,
        )
        for seg in segs:
            words = [{"w": w.word.strip(), "s": round(w.start, 2), "e": round(w.end, 2), "p": round(w.probability, 2)}
                     for w in (seg.words or []) if w.word.strip()]
            if words:
                n_words += len(words)
                print(json.dumps({"chn": c, "words": words}), flush=True)
            log(type="progress", pct=round(min(1.0, (done_audio + seg.end) / span), 3))
        done_audio += total
    print(json.dumps({"done": True, "words": n_words}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
