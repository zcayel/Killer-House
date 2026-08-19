"""Generates assets/sounds/forcefield_hit.wav — the barrier impact.

There is no barrier-impact clip in assets/sounds, so forceField.ts had been
borrowing spike_thrust.mp3 at 40% pitch as a stand-in. That reads as a muffled
metal noise, not an energy field. This builds a purpose-made one out of five
layers, using nothing but the standard library:

  1. impact noise   - bandpassed white noise, very fast decay. The "smack".
  2. zap sweep      - a sine falling 2600 -> 500 Hz. The electric snap.
  3. barrier warble - two detuned sines beating against each other, softly
                      clipped. This is the layer that says "force field"
                      rather than "hit something".
  4. sub thump      - 52 Hz, gone in 90ms. Weight on phone speakers.
  5. energy tail    - narrow noise band with tremolo, ringing out after the
                      impact, so the field sounds like it is still there.

Length is matched to FORCE_FIELD_SECONDS (0.55) plus a tail that rings past
the visual, which is how a real impact behaves. Deterministic: the RNG is
seeded, so re-running produces a byte-identical file.

Run:  python forcefield-source/make_forcefield_sound.py
"""
import math
import os
import random
import struct
import wave

SR = 44100
DUR = 0.85
N = int(SR * DUR)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'sounds', 'forcefield_hit.wav')

random.seed(20260817)


def one_pole(fc):
    """Coefficient for a one-pole filter at fc Hz."""
    return 1.0 - math.exp(-2.0 * math.pi * fc / SR)


buf = [0.0] * N

# ── 1 + 5. noise layers ───────────────────────────────────────────────────
# Two independent bandpasses off the same noise source: a bright wideband one
# for the smack, a narrow one that rings on as the field's hum.
a_lo_hi, a_lo_lo = one_pole(6000.0), one_pole(1500.0)
a_tl_hi, a_tl_lo = one_pole(2600.0), one_pole(2000.0)
lp1 = lp2 = lp3 = lp4 = 0.0
for n in range(N):
    t = n / SR
    w = random.uniform(-1.0, 1.0)

    lp1 += a_lo_hi * (w - lp1)      # rolls off above 6k
    lp2 += a_lo_lo * (lp1 - lp2)    # ... and below 1.5k, leaving a band
    impact = (lp1 - lp2) * math.exp(-t / 0.045) * 0.62

    lp3 += a_tl_hi * (w - lp3)
    lp4 += a_tl_lo * (lp3 - lp4)
    tail_env = (1.0 - math.exp(-t / 0.030)) * math.exp(-t / 0.34)
    tremolo = 0.65 + 0.35 * math.sin(2.0 * math.pi * 11.0 * t)
    tail = (lp3 - lp4) * tail_env * tremolo * 0.30

    buf[n] += impact + tail

# ── 2. zap sweep ──────────────────────────────────────────────────────────
phase = 0.0
for n in range(N):
    t = n / SR
    f = 500.0 + (2600.0 - 500.0) * math.exp(-t / 0.055)   # 2600 -> 500 Hz
    phase += 2.0 * math.pi * f / SR
    buf[n] += math.sin(phase) * math.exp(-t / 0.075) * 0.34

# ── 3. barrier warble ─────────────────────────────────────────────────────
# 138 and 145.5 Hz beat at 7.5 Hz; the fifth on top keeps it from sounding
# like a plain hum. tanh gives it an electric edge without harsh clipping.
for n in range(N):
    t = n / SR
    env = min(1.0, t / 0.004) * math.exp(-t / 0.30)
    v = (math.sin(2.0 * math.pi * 138.0 * t)
         + math.sin(2.0 * math.pi * 145.5 * t)
         + 0.45 * math.sin(2.0 * math.pi * 207.0 * t))
    buf[n] += math.tanh(v * 1.5) * env * 0.42

# ── 4. sub thump ──────────────────────────────────────────────────────────
for n in range(N):
    t = n / SR
    buf[n] += math.sin(2.0 * math.pi * 52.0 * t) * math.exp(-t / 0.090) * 0.70

# ── glue: soft clip, normalise, de-click ──────────────────────────────────
buf = [math.tanh(v * 0.9) for v in buf]
peak = max(abs(v) for v in buf) or 1.0
gain = 0.92 / peak
fade_in = int(SR * 0.002)
fade_out = int(SR * 0.030)
for n in range(N):
    v = buf[n] * gain
    if n < fade_in:
        v *= n / fade_in
    if n > N - fade_out:
        v *= (N - n) / fade_out
    buf[n] = v

with wave.open(os.path.normpath(OUT), 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(b''.join(struct.pack('<h', int(max(-1.0, min(1.0, v)) * 32767)) for v in buf))

rms = math.sqrt(sum(v * v for v in buf) / N)
print(f'wrote {os.path.normpath(OUT)}')
print(f'  {DUR}s, {SR}Hz mono 16-bit, {N} frames, {os.path.getsize(os.path.normpath(OUT))} bytes')
print(f'  peak {max(abs(v) for v in buf):.3f}   rms {rms:.3f}')
