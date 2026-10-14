# Local streaming STT feasibility (faster-whisper, CPU)

## Hardware
AMD Ryzen 7 PRO 7840U (8 cores / 16 threads), 27.7 GB RAM, Radeon 780M iGPU. No NVIDIA GPU, no CUDA
(ctranslate2 reports 0 CUDA devices). All runs: CPU, int8, 8 threads, beam 1, faster-whisper 1.2.1.

## Method
- Test audio: Windows System.Speech (Microsoft David), 39.0 s, 16 kHz mono, ~100 words of meeting-style sentences.
- Streaming simulation: re-transcribe a growing buffer (trimmed to the last commit when >12 s) every STEP seconds
  with word timestamps; commit the longest common prefix of two consecutive hypotheses (LocalAgreement-2,
  simplified whisper_streaming), committed text fed back as initial_prompt. Virtual clock: audio is "available"
  at wall time = audio time, each step costs its real measured compute time (single-threaded pipeline).
- Latency = wall time word is emitted minus the word's end time in audio. "commit" = confirmed by agreement;
  "hyp" = first time the word appeared in any hypothesis (comparable to cloud partials).

## Results (39 s audio)
| model | step | commit p50 / p90 | hyp p50 / p90 | RTF (compute/audio) | avg CPU cores | WER offline | WER streamed |
|---|---|---|---|---|---|---|---|
| tiny.en | 0.5 s | 1.32 / 3.25 s | 0.66 / 2.10 s | 0.87 | 6.2 | 1.7% | 22.6% |
| tiny.en | 1.0 s | 1.85 / 3.03 s | 0.69 / 1.25 s | 0.39 | 7.3 | 1.7% | 20.0% |
| base.en | 0.5 s | 2.16 / 3.80 s | 1.10 / 2.43 s | 0.96 | 7.6 | 1.7% | 20.9% |
| base.en | 1.0 s | 2.44 / 4.50 s | 1.19 / 2.68 s | 0.65 | 7.6 | 1.7% | 17.4% |
| small.en | 1.0 s | 4.70 / 7.46 s | 2.41 / 3.32 s | 1.05 | 7.6 | 2.6% | 9.6% |
| small.en | 2.0 s | 5.62 / 8.79 s | 2.90 / 6.02 s | 0.92 | 7.6 | 2.6% | 8.7% |

Offline (whole file in one pass): tiny 1.0 s, base 1.6 s, small 4.8 s for 39 s of audio.

## Interpretation
- p50 < 2 s is reached only by tiny.en (commit 1.3-1.85 s; first-hypothesis 0.7 s) and, marginally on commit, not by base.en (2.2-2.4 s; hypothesis 1.1-1.2 s). small.en is ~2.4 s for hypotheses and ~5 s for committed words and runs at RTF ~1.0 (not sustainable).
- Every config uses 6-8 of 16 threads continuously. This is for ONE mono stream; MeetBot has two channels (mic + system), so double the load. tiny.en step 1.0 (RTF 0.39 per channel) is the only config that plausibly fits two channels.
- Accuracy: offline WER is 1.7% (tiny/base) and 2.6% (small) on clean TTS, but streamed WER was 9-23%. Much of the streamed degradation is likely my simplified commit/trim logic (dropped or duplicated words at buffer boundaries), not model quality, so treat streamed WER as a pessimistic upper bound. Clean synthetic TTS is far easier than real meetings; real-speech WER for tiny.en is typically much worse than small.en.

## Could not measure
- Real human/meeting speech, accents, noise, crosstalk, system-audio echo; cloud WER on the same audio (no direct comparison done).
- Word-end ground truth: TTS word-progress events did not fire, so word end times come from whisper's own full-file alignment (approximate, +/- ~0.1-0.3 s).
- GPU/iGPU (Radeon 780M) acceleration: ctranslate2 has no ROCm/DirectML path; not tried. whisper_streaming / whisper-live were not installed; the agreement logic was a hand-written approximation.
- True wall-clock concurrent run with live audio capture and two channels; Python 3.13 sidecar packaging size.

## Recommendation
Local STT can beat ~2 s on this machine only with tiny.en (hypothesis ~0.7 s, commit ~1.3-1.9 s), at noticeably worse accuracy than small.en or the cloud and heavy CPU use. base.en is borderline (~2.2 s commit) and small.en is too slow. A reasonable use is a low-latency "draft" tier for the live view, with accurate text from the cloud or a post-meeting small.en pass for transcript.md.

## Integration sketch
Add a Python sidecar (e.g. sidecar/local_stt.py) that reads the same 6400-byte stereo frames on stdin, splits channels, runs one faster-whisper loop per channel, and writes JSON lines shaped like Voicegain payloads:
`{"segment":[{"type":"hypothesis"|"recognition","alternatives":[{"text":..,"confidence":..}],"time":ms,"duration":ms,"spk":0|1}]}`
(uncommitted tail = hypothesis; agreement-confirmed prefix = recognition; spk = channel). Add a `src/voicegain/`-compatible "link" implementation in the session deps that feeds these lines to the existing parse.js, so TranscriptBuilder and crash-recovery logs (.data raw log) work unchanged. Note Whisper gives no real per-word confidence (use avg_logprob mapped to 0-1) and no diarization.
