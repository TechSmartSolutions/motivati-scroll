#!/usr/bin/env python3
"""Transcribe one media file with faster-whisper (local, CPU) and write JSON.

Usage: transcribe.py --model small --model-dir /data/models --threads 6 INPUT OUTPUT.json
Called by server/transcriber.mjs, one file per run.
"""
import argparse
import json
import sys

from faster_whisper import WhisperModel


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="small")
    ap.add_argument("--model-dir", default=None)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--language", default=None, help="force a language code; default is auto-detect")
    ap.add_argument("input")
    ap.add_argument("output")
    args = ap.parse_args()

    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        cpu_threads=args.threads,
        download_root=args.model_dir,
    )
    # vad_filter skips silence and music-only stretches, which keeps motivational clips clean.
    segments, info = model.transcribe(args.input, language=args.language, vad_filter=True)
    segs = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segments]
    out = {
        "model": args.model,
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration": round(info.duration, 2),
        "text": " ".join(s["text"] for s in segs).strip(),
        "segments": segs,
    }
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
