#!/usr/bin/env python3
"""Voice Input plugin - Python worker for local ASR transcription.

Long-running process. Reads JSON commands from stdin, writes JSON responses to stdout.
Audio arrives as base64-encoded float32 PCM (16kHz mono) — no ffmpeg needed.
"""
import base64
import json
import os
import struct
import sys
import tempfile
import time

import numpy as np

_model = None


def respond(msg_id, data):
    sys.stdout.write(json.dumps({"id": msg_id, **data}) + "\n")
    sys.stdout.flush()


def load_model(*, local_files_only=True):
    global _model
    if _model is not None:
        return
    from faster_whisper import WhisperModel
    _model = WhisperModel("small", device="auto", compute_type="int8",
                          local_files_only=local_files_only)


def write_wav(pcm_f32):
    """Write float32 PCM to a temp WAV file (16-bit, 16kHz, mono). For faster-whisper."""
    fd, path = tempfile.mkstemp(suffix=".wav")
    pcm16 = np.clip(pcm_f32, -1.0, 1.0)
    pcm16 = (pcm16 * 32767).astype(np.int16)
    data = pcm16.tobytes()
    n = len(data)
    # WAV header
    header = struct.pack('<4sI4s4sIHHIIHH4sI',
        b'RIFF', 36 + n, b'WAVE',
        b'fmt ', 16, 1, 1, 16000, 32000, 2, 16,
        b'data', n)
    os.write(fd, header + data)
    os.close(fd)
    return path


def transcribe(pcm_f32, lang="auto"):
    # faster-whisper needs a file
    path = write_wav(pcm_f32)
    try:
        kwargs = {"task": "transcribe"}
        if lang and lang != "auto":
            kwargs["language"] = lang
        segs, info = _model.transcribe(path, **kwargs)
        segs = list(segs)
        text = "".join(s.text for s in segs).strip()
        lps = [s.avg_logprob for s in segs if s.avg_logprob is not None]
        return {
            "text": text,
            "avg_logprob": sum(lps) / len(lps) if lps else None,
            "language": getattr(info, "language", "unknown"),
        }
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def handle(cmd):
    cid = cmd.get("id", "")
    action = cmd.get("action")

    if action == "warmup":
        try:
            load_model()
            respond(cid, {"status": "ready"})
        except Exception as e:
            respond(cid, {"status": "error", "error": str(e)})

    elif action == "transcribe":
        try:
            raw = base64.b64decode(cmd.get("audio", ""))
            pcm_f32 = np.frombuffer(raw, dtype=np.float32)
            lang = cmd.get("lang", "auto")
            t0 = time.perf_counter()
            result = transcribe(pcm_f32, lang)
            elapsed = time.perf_counter() - t0
            respond(cid, {
                "text": result.get("text", ""),
                "avg_logprob": result.get("avg_logprob"),
                "language": result.get("language", "unknown"),
                "inference_time": round(elapsed, 2),
            })
        except Exception as e:
            respond(cid, {"error": str(e)})

    elif action == "status":
        respond(cid, {"loaded": _model is not None, "backend": "faster_whisper"})


def main():
    respond("init", {"status": "started"})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            handle(json.loads(line))
        except Exception as e:
            respond("error", {"error": str(e)})


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] in ("--prepare-model", "--check"):
        load_model(local_files_only=sys.argv[1] == "--check")
        print("Local voice model ready.")
    else:
        main()
