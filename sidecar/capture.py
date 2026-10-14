#!/usr/bin/env python3
"""MeetBot capture sidecar (Windows).

Captures what you HEAR (WASAPI loopback of the default speakers) and your MICROPHONE, and writes a single
interleaved STEREO stream to stdout:  16 kHz, signed 16-bit little-endian, LEFT = microphone, RIGHT = system audio.
Frames are emitted every 100 ms on a wall clock, padded with silence, so the two channels stay time-aligned even
though loopback produces no data while nothing is playing.

stdout = raw PCM only.  stderr = JSON lines (status/warnings).  Exits when stdin closes (parent went away).

  python capture.py              capture until stdin closes / Ctrl+C
  python capture.py --list       list devices as JSON
  python capture.py --check      verify dependencies and devices (exit code 0 = ok)
  python capture.py --selftest 5 emit 5 s of synthetic audio (no devices needed) to test the pipe
"""
import argparse
import json
import math
import sys
import threading
import time

import numpy as np

SR = 16000
FRAME = SR // 10  # 100 ms


def log(**kw):
    sys.stderr.write(json.dumps(kw) + "\n")
    sys.stderr.flush()


def to_16k(x, rate):
    """int16 mono at `rate` -> float32 at 16 kHz (box filter when the ratio is an integer, else linear)."""
    f = x.astype(np.float32) / 32768.0
    if rate == SR or len(f) == 0:
        return f
    if rate % SR == 0:
        k = rate // SR
        n = len(f) // k * k
        return f[:n].reshape(-1, k).mean(axis=1) if n else f[:0]
    n_out = int(round(len(f) * SR / rate))
    if n_out <= 0:
        return f[:0]
    return np.interp(np.linspace(0, len(f) - 1, n_out), np.arange(len(f)), f).astype(np.float32)


class Track:
    """Thread-safe FIFO of 16 kHz float32 samples."""

    def __init__(self, max_lag=0.5):
        self.lock = threading.Lock()
        self.chunks, self.n = [], 0
        self.max_lag = int(max_lag * SR)

    def push(self, a):
        with self.lock:
            self.chunks.append(a)
            self.n += len(a)

    def take(self, count):
        with self.lock:
            if self.n > self.max_lag + count:  # device clock ran fast: drop oldest, never build latency
                drop = self.n - self.max_lag
                self._pop(drop)
            out = self._pop(min(count, self.n))
        if len(out) < count:
            out = np.concatenate([out, np.zeros(count - len(out), dtype=np.float32)])
        return out

    def _pop(self, count):
        if count <= 0:
            return np.zeros(0, dtype=np.float32)
        parts, need = [], count
        while need > 0 and self.chunks:
            c = self.chunks[0]
            if len(c) <= need:
                parts.append(c)
                need -= len(c)
                self.chunks.pop(0)
            else:
                parts.append(c[:need])
                self.chunks[0] = c[need:]
                need = 0
        self.n -= count - need
        return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)


class Mixer:
    def __init__(self):
        self.left, self.right = Track(), Track()  # left = mic, right = system

    def frame(self):
        """100 ms of interleaved stereo int16 bytes."""
        inter = np.empty(FRAME * 2, dtype=np.float32)
        inter[0::2] = self.left.take(FRAME)
        inter[1::2] = self.right.take(FRAME)
        return (np.clip(inter, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def pump(mixer, stop, out=None):
    out = out or sys.stdout.buffer
    nxt = time.monotonic()
    while not stop.is_set():
        nxt += 0.1
        out.write(mixer.frame())
        out.flush()
        delay = nxt - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        elif delay < -1.0:  # we stalled badly; re-anchor instead of bursting
            nxt = time.monotonic()


def watch_stdin(stop):
    def run():
        try:
            while sys.stdin.buffer.read(1024):
                pass
        except Exception:
            pass
        stop.set()
    threading.Thread(target=run, daemon=True).start()


def find_devices(pa, mic_hint=None, loop_hint=None):
    import pyaudiowpatch as pyaudio
    wasapi = pa.get_host_api_info_by_type(pyaudio.paWASAPI)
    out_dev = pa.get_device_info_by_index(wasapi["defaultOutputDevice"])
    loop = None
    if loop_hint is not None:
        for d in pa.get_loopback_device_info_generator():
            if str(d["index"]) == str(loop_hint) or str(loop_hint).lower() in d["name"].lower():
                loop = d
                break
    else:
        for d in pa.get_loopback_device_info_generator():
            if out_dev["name"] in d["name"]:
                loop = d
                break
    if mic_hint is not None:
        mic = None
        for i in range(pa.get_device_count()):
            d = pa.get_device_info_by_index(i)
            if d["maxInputChannels"] > 0 and not d.get("isLoopbackDevice") and (
                    str(i) == str(mic_hint) or str(mic_hint).lower() in d["name"].lower()):
                mic = d
                break
    else:
        mic = pa.get_device_info_by_index(wasapi["defaultInputDevice"])
    return mic, loop


def run_capture(args):
    import pyaudiowpatch as pyaudio
    pa = pyaudio.PyAudio()
    mixer, streams = Mixer(), []
    stop = threading.Event()
    try:
        mic, loop = find_devices(pa, args.mic, args.loopback)

        def open_track(dev, track, label):
            rate, ch = int(dev["defaultSampleRate"]), int(dev["maxInputChannels"])

            def cb(data, frames, ti, status):
                a = np.frombuffer(data, dtype=np.int16)
                if ch > 1:
                    a = a.reshape(-1, ch).mean(axis=1).astype(np.int16)
                track.push(to_16k(a, rate))
                return (None, pyaudio.paContinue)

            s = pa.open(format=pyaudio.paInt16, channels=ch, rate=rate, input=True, input_device_index=dev["index"],
                        frames_per_buffer=max(256, rate // 50), stream_callback=cb)
            streams.append(s)
            log(type="info", msg=f"{label}: {dev['name']} ({rate} Hz, {ch} ch)")

        if not args.no_mic:
            if mic is None:
                log(type="warn", msg="microphone not found; channel will be silent")
            else:
                open_track(mic, mixer.left, "mic")
        if not args.no_system:
            if loop is None:
                log(type="warn", msg="no loopback device for the default speakers; system audio will be silent")
            else:
                open_track(loop, mixer.right, "system")
        watch_stdin(stop)
        log(type="ready")
        try:
            pump(mixer, stop)
        except (KeyboardInterrupt, BrokenPipeError):
            pass
    finally:
        stop.set()
        for s in streams:
            try:
                s.stop_stream()
                s.close()
            except Exception:
                pass
        pa.terminate()


def selftest(seconds):
    mixer, stop = Mixer(), threading.Event()

    def gen():
        t = 0
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            idx = np.arange(t, t + 1600)
            mixer.left.push((0.3 * np.sin(2 * math.pi * 440 * idx / SR)).astype(np.float32))
            mixer.right.push((0.3 * np.sin(2 * math.pi * 880 * idx / SR)).astype(np.float32))
            t += 1600
            time.sleep(0.1)
        stop.set()
    threading.Thread(target=gen, daemon=True).start()
    log(type="ready")
    pump(mixer, stop)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--selftest", type=float, metavar="SECONDS")
    ap.add_argument("--mic")
    ap.add_argument("--loopback")
    ap.add_argument("--no-mic", action="store_true")
    ap.add_argument("--no-system", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest(args.selftest)
    try:
        import pyaudiowpatch as pyaudio
    except ImportError:
        log(type="error", msg="pyaudiowpatch is not installed. Run: pip install pyaudiowpatch numpy")
        sys.exit(2)
    if args.list or args.check:
        pa = pyaudio.PyAudio()
        try:
            mic, loop = find_devices(pa, args.mic, args.loopback)
            info = {"mic": mic and mic["name"], "loopback": loop and loop["name"],
                    "loopbackDevices": [d["name"] for d in pa.get_loopback_device_info_generator()]}
            print(json.dumps(info))
            sys.exit(0 if (mic and loop) else 1)
        finally:
            pa.terminate()
    run_capture(args)


if __name__ == "__main__":
    main()
