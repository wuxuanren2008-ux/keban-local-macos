"""Make raw 16 kHz mono PCM from a synthetic voice fixture on the test host."""
from pathlib import Path
import wave
import numpy as np
from faster_whisper.audio import decode_audio
root = Path(__file__).resolve().parents[1]
audio = root / 'test-results/synthetic-economics.wav'
if not audio.exists():
    audio = root / 'test-results/synthetic-economics.aiff'
decode_audio(str(audio), sampling_rate=16000).astype('<f4').tofile(root / 'test-results/synthetic-economics.raw')
samples_for_stats=decode_audio(str(audio),sampling_rate=16000)
print('Synthetic audio:', len(samples_for_stats)/16000, 'seconds; peak', float(np.max(np.abs(samples_for_stats))))
with wave.open(str(root / 'test-results/fake-microphone.wav'), 'wb') as output:
    output.setnchannels(1)
    output.setsampwidth(2)
    output.setframerate(48000)
    samples = decode_audio(str(audio), sampling_rate=48000)
    output.writeframes((np.clip(samples, -1, 1)*32767).astype('<i2').tobytes())
