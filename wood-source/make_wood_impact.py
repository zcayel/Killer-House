"""Synthesise the plank's floor impact: a heavy wooden board landing on stone.

Stdlib only (wave + struct + math), seeded, so re-running gives byte-identical
output. Layered the way a real board sounds when it drops:

  1. TRANSIENT  - the crack of contact. Filtered noise burst, ~12ms, the part
     that makes it read as "hit" rather than "hum".
  2. BODY       - the board's own resonance. A 4.1m plank is a long bar, so the
     modes are low and closely spaced; these are struck-bar ratios, not a
     harmonic series, which is what stops it sounding like a musical note.
  3. THUMP      - the floor answering, a fast pitch-dropping sine, the weight.
  4. RATTLE     - a short tail of small irregular knocks, the board settling.

Mono 44.1kHz 16-bit, which is what the rest of assets/sounds uses.
"""
import math
import os
import random
import struct
import wave

RATE = 44100
DUR = 0.85
N = int(RATE * DUR)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   '..', 'assets', 'sounds', 'wood_impact.wav')

rng = random.Random(20260818)


def env(i, attack, decay, power=1.0):
    """Fast attack, exponential decay, both in seconds."""
    t = i / RATE
    if t < attack:
        a = t / attack if attack > 0 else 1.0
    else:
        a = math.exp(-(t - attack) / decay)
    return a ** power


buf = [0.0] * N

# ---- 1. transient: the crack of contact -----------------------------------
# One-pole low-passed white noise. Bright but not hissy: a board is not a snare.
prev = 0.0
for i in range(N):
    t = i / RATE
    if t > 0.05:
        break
    white = rng.uniform(-1.0, 1.0)
    prev = prev + 0.35 * (white - prev)          # ~5kHz one-pole
    buf[i] += prev * env(i, 0.0006, 0.012) * 0.9

# ---- 2. body: struck-bar modes of a long plank ----------------------------
# Free-free bar overtone ratios (1, 2.76, 5.40, 8.93) - inharmonic, which is
# exactly why wood reads as wood and not as a tuned instrument.
F0 = 96.0
for ratio, amp, dec in ((1.00, 1.00, 0.26), (2.76, 0.55, 0.17),
                        (5.40, 0.28, 0.11), (8.93, 0.14, 0.07)):
    f = F0 * ratio
    phase = rng.uniform(0, 2 * math.pi)
    for i in range(N):
        e = env(i, 0.0012, dec)
        if i / RATE > 0.0012 and e < 1e-4:   # only bail AFTER the attack ramp
            break
        buf[i] += math.sin(2 * math.pi * f * i / RATE + phase) * e * amp * 0.30

# ---- 3. thump: the floor taking the weight --------------------------------
# Sine sweeping 150Hz -> 48Hz over its decay; the drop is what gives it mass.
phase = 0.0
for i in range(N):
    e = env(i, 0.002, 0.11)
    if i / RATE > 0.002 and e < 1e-4:        # only bail AFTER the attack ramp
        break
    f = 48.0 + 102.0 * math.exp(-(i / RATE) / 0.045)
    phase += 2 * math.pi * f / RATE
    buf[i] += math.sin(phase) * e * 0.55

# ---- 4. rattle: the board settling ----------------------------------------
for _ in range(7):
    start = int(RATE * rng.uniform(0.10, 0.55))
    amp = rng.uniform(0.04, 0.13)
    f = rng.uniform(180.0, 620.0)
    dec = rng.uniform(0.010, 0.035)
    phase = rng.uniform(0, 2 * math.pi)
    for k in range(int(RATE * 0.09)):
        i = start + k
        if i >= N:
            break
        buf[i] += math.sin(2 * math.pi * f * k / RATE + phase) * math.exp(-(k / RATE) / dec) * amp

# ---- normalise, de-click the tail, write ----------------------------------
peak = max(abs(v) for v in buf) or 1.0
gain = 0.92 / peak
fade = int(RATE * 0.03)
frames = bytearray()
for i, v in enumerate(buf):
    v *= gain
    if i > N - fade:                      # never end on a step
        v *= (N - i) / fade
    v = max(-1.0, min(1.0, v))
    frames += struct.pack('<h', int(v * 32767))

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with wave.open(OUT, 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(bytes(frames))

vals = [struct.unpack('<h', frames[i * 2:i * 2 + 2])[0] / 32768.0 for i in range(N)]
print('wrote %s' % os.path.normpath(OUT))
print('  %.2fs, %d Hz mono 16-bit, %d bytes' % (DUR, RATE, len(frames) + 44))
print('  peak %.3f   dc %.5f   clipped samples %d'
      % (max(abs(v) for v in vals), sum(vals) / len(vals),
         sum(1 for v in vals if abs(v) >= 0.999)))
for a, b in ((0.0, 0.05), (0.05, 0.2), (0.2, 0.5), (0.5, 0.85)):
    seg = vals[int(a * RATE):int(b * RATE)]
    print('  rms %.2f-%.2fs: %.3f' % (a, b, math.sqrt(sum(v * v for v in seg) / len(seg))))
