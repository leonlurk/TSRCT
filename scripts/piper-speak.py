#!/usr/bin/env python3
"""piper-speak.py — say any text out loud, on the CPU, with the card untouched.

Reads text on stdin, writes a WAV. Piper is a small neural voice that runs on
onnxruntime; there is no GPU in this path at all, which is the entire point:
the morning brief can be read at 9am while ComfyUI or a model owns the card.

WHY THIS WRAPPER EXISTS INSTEAD OF `python -m piper`:
  the module's CLI builds its own onnxruntime session, and onnxruntime defaults
  to ALL cores. Measured on this laptop, one 213-word brief pinned ~21 cores for
  16 seconds (2150% CPU) — on a machine that runs five Claude sessions and has
  11 GB of RAM, that is a stall everyone else feels. Here the session is built
  by hand so the thread count is OURS, and the default is deliberately low.
  Slower wall time on a job nobody is waiting on is the right trade.

Usage:
  echo "hello" | piper-speak.py --out /tmp/x.wav
  piper-speak.py --voice en_US-lessac-high --threads 4 --out x.wav < text.txt
  piper-speak.py --list                      # what is downloaded
"""
import argparse
import json
import os
import sys
import time
import wave
from pathlib import Path

DEFAULT_DIR = Path(os.environ.get('PIPER_VOICE_DIR', Path.home() / '.local/share/vrtx/piper'))
DEFAULT_VOICE = os.environ.get('PIPER_VOICE', 'en_US-lessac-high')
DEFAULT_THREADS = int(os.environ.get('PIPER_THREADS', '4'))


def list_voices(voice_dir: Path) -> None:
    for p in sorted(voice_dir.glob('*.onnx')):
        size = p.stat().st_size / 1e6
        print(f'{p.stem}\t{size:.0f} MB')


def load_voice(voice_dir: Path, name: str, threads: int):
    import onnxruntime
    from piper import PiperVoice
    from piper.config import PiperConfig

    model = voice_dir / f'{name}.onnx'
    if not model.exists():
        sys.exit(f'[piper] no such voice: {model}\n'
                 f'        download one with: python -m piper.download_voices {name} --data-dir {voice_dir}')
    with open(f'{model}.json', encoding='utf-8') as fh:
        config = PiperConfig.from_dict(json.load(fh))

    opts = onnxruntime.SessionOptions()
    opts.intra_op_num_threads = threads      # the whole reason this file exists
    opts.inter_op_num_threads = 1
    opts.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = onnxruntime.InferenceSession(
        str(model), sess_options=opts, providers=['CPUExecutionProvider'])
    return PiperVoice(session=session, config=config)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--voice', default=DEFAULT_VOICE)
    ap.add_argument('--voice-dir', default=str(DEFAULT_DIR))
    ap.add_argument('--threads', type=int, default=DEFAULT_THREADS)
    ap.add_argument('--out', default='')
    ap.add_argument('--list', action='store_true')
    args = ap.parse_args()

    voice_dir = Path(args.voice_dir).expanduser()
    if args.list:
        list_voices(voice_dir)
        return 0
    if not args.out:
        sys.exit('[piper] --out is required')

    text = sys.stdin.read().strip()
    if not text:
        sys.exit('[piper] nothing to say (empty stdin)')

    started = time.time()
    voice = load_voice(voice_dir, args.voice, max(1, args.threads))
    loaded = time.time()
    with wave.open(args.out, 'wb') as wav:
        voice.synthesize_wav(text, wav)
    with wave.open(args.out, 'rb') as wav:
        seconds = wav.getnframes() / wav.getframerate()
    done = time.time()
    # Machine-readable, on stderr, so the caller can log the cost without
    # parsing the audio: a TTS call that quietly takes a minute is a bug you
    # only find by measuring it.
    print(json.dumps({
        'ok': True, 'voice': args.voice, 'threads': args.threads,
        'chars': len(text), 'audio_s': round(seconds, 1),
        'load_s': round(loaded - started, 1), 'synth_s': round(done - loaded, 1),
        'faster_than_real_time': round(seconds / max(0.001, done - loaded), 2),
    }), file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
