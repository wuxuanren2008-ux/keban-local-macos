"""Streaming core for local Whisper ASR via WebSocket.

Manages the WebSocket lifecycle: start protocol, audio buffering,
segment-level transcription, caption state tracking, and stop/flush.

Adapted from the cloud whisper-client protocol (captions.js / CaptionState),
kept as a local-only loopback service with no cloud fallback.
"""

import asyncio
import json
import logging
import math
import struct
import uuid
from typing import Any

import numpy as np

from desktop.asr import ASRManager
from desktop.storage import Storage

logger = logging.getLogger(__name__)

# Audio constants
SAMPLE_RATE = 16000
# Buffer ~2 seconds of audio before transcribing
MIN_SEGMENT_SAMPLES = SAMPLE_RATE * 2  # 32000 samples = 2s
MAX_SEGMENT_SAMPLES = SAMPLE_RATE * 8  # 128000 samples = 8s
SILENCE_THRESHOLD = 0.008
MAX_PACKET_SAMPLES = SAMPLE_RATE * 30  # 30s max per packet — reject oversize


class CaptionState:
    """Track committed segment IDs and current draft (matches CaptionState.js).

    The server generates a monotonically increasing sequence number;
    accept() processes it and deduplicates segment IDs.
    """

    def __init__(self):
        self.sequence = -1
        self.draft = ""
        self.committed: set[str] = set()

    def accept(self, update: dict) -> dict | None:
        """Accept an update if its sequence is strictly greater than the last seen."""
        seq = update.get("sequence")
        if not isinstance(seq, int) or seq <= self.sequence:
            return None
        self.sequence = seq
        stable_out = []
        for seg in update.get("stable", []):
            if not seg or not isinstance(seg.get("id"), str):
                continue
            if not isinstance(seg.get("text"), str) or not seg["text"].strip():
                continue
            if seg["id"] in self.committed:
                continue
            self.committed.add(seg["id"])
            stable_out.append(seg)
        self.draft = update.get("draft", "")
        return {"stable": stable_out, "draft": self.draft}


def _validate_pcm(data: bytes) -> np.ndarray | None:
    """Validate and decode little-endian float32 PCM. Returns None if invalid."""
    if not data or len(data) < 4:
        return None
    if len(data) % 4 != 0:
        logger.warning("PCM packet not float32-aligned: %d bytes", len(data))
        return None
    samples = np.frombuffer(data, dtype="<f4")  # little-endian float32
    if len(samples) > MAX_PACKET_SAMPLES:
        logger.warning("PCM packet too large: %d samples", len(samples))
        return None
    # Reject non-finite (NaN/Inf) values
    if not np.all(np.isfinite(samples)):
        logger.warning("PCM contains non-finite values")
        return None
    return samples.astype(np.float32)


class StreamingSession:
    """One WebSocket connection's session state."""

    def __init__(self, websocket, asr: ASRManager, storage: Storage):
        self.ws = websocket
        self.asr = asr
        self.storage = storage
        self.caption_state = CaptionState()
        self.language = "en"
        self.course_id: str | None = None
        self.audio_buffer: list[np.ndarray] = []
        self.buffer_samples = 0
        self.consumed_samples = 0  # total samples processed (for timestamp base)
        self.running = False
        self.initial_prompt = ""
        self._segment_counter = 0
        self._seq = -1  # server-side sequence counter
        self._session_lock = asyncio.Lock()  # capacity mutex for this session

    def _next_seq(self) -> int:
        """Generate next sequence number (does NOT touch CaptionState.sequence)."""
        self._seq += 1
        return self._seq

    async def handle_start(self, msg: dict) -> dict:
        """Process the start message, return ready or error."""
        # Validate sample_rate
        sr = msg.get("sample_rate")
        if sr != SAMPLE_RATE:
            return {"type": "error", "error": f"sample_rate must be {SAMPLE_RATE}, got {sr}"}

        # Validate language
        lang = msg.get("language", "en")
        if lang not in ("en", "ms", "zh"):
            return {"type": "error", "error": f"language must be 'en', 'ms' or 'zh', got '{lang}'"}
        self.language = lang
        self.course_id = msg.get("course_id")
        self.running = True

        # Build initial_prompt from course corrections
        if self.course_id:
            corrections = self.storage.get_corrections_for_prompt(self.course_id)
            self.initial_prompt = self.asr.build_initial_prompt(corrections)

        # Check if ASR engine is available — load in thread to avoid blocking
        engine = self.asr.get_engine()
        if not engine.ready:
            try:
                await asyncio.to_thread(engine.ensure_loaded)
            except RuntimeError as exc:
                return {
                    "type": "error",
                    "error": f"Whisper model not ready: {exc}. "
                             f"Please download the model first.",
                }
            except Exception as exc:
                return {
                    "type": "error",
                    "error": f"Failed to initialise Whisper: {exc}",
                }

        return {"type": "ready"}

    async def process_audio(self, data: bytes) -> dict | None:
        """Process incoming audio bytes, return captions update or None."""
        samples = _validate_pcm(data)
        if samples is None:
            return None
        if len(samples) == 0:
            return None

        self.audio_buffer.append(samples)
        self.buffer_samples += len(samples)

        # Check for silence to trigger segment boundary
        energy = float(np.sqrt(np.mean(samples ** 2))) if len(samples) > 0 else 0.0
        has_speech = energy > SILENCE_THRESHOLD

        # Transcribe when buffer is large enough
        should_transcribe = (
            self.buffer_samples >= MAX_SEGMENT_SAMPLES
            or (self.buffer_samples >= MIN_SEGMENT_SAMPLES and not has_speech)
        )
        if not should_transcribe:
            return None

        return await self._transcribe_buffer()

    async def _transcribe_buffer(self) -> dict | None:
        """Run transcription on buffered audio and return captions update."""
        if self.buffer_samples == 0:
            return None

        # Wait for session lock (capacity mutex) — don't silently drop
        async with self._session_lock:
            if self.buffer_samples == 0:
                return None  # another task already consumed it

            audio = np.concatenate(self.audio_buffer)
            buf_samples = self.buffer_samples
            self.audio_buffer = []
            self.buffer_samples = 0

            # Transcribe in thread to avoid blocking event loop
            segments = await asyncio.to_thread(self._transcribe_sync, audio)

        # Compute timestamps from consumed audio, not model segment times
        base_time = self.consumed_samples / SAMPLE_RATE
        self.consumed_samples += buf_samples

        if not segments:
            return None

        stable = []
        for seg in segments:
            text = seg.get("text", "").strip()
            if not text:
                continue
            self._segment_counter += 1
            seg_id = f"seg-{self._segment_counter}"
            # Use model-relative offsets added to base_time (consumed audio base)
            seg_start = base_time + seg.get("start", 0.0)
            seg_end = base_time + seg.get("end", seg.get("start", 0.0))
            stable.append({
                "id": seg_id,
                "text": text,
                "start": round(seg_start, 2),
                "end": round(seg_end, 2),
            })

        if not stable:
            return None

        seq = self._next_seq()
        accepted = self.caption_state.accept({
            "sequence": seq,
            "stable": stable,
            "draft": "",
        })
        if not accepted:
            return None
        return {
            "type": "captions",
            "sequence": seq,
            "stable": accepted["stable"],
            "draft": accepted["draft"],
        }

    def _transcribe_sync(self, audio: np.ndarray) -> list[dict]:
        """Synchronous transcription — runs in thread."""
        engine = self.asr.get_engine()
        return engine.transcribe_segment(
            audio,
            language=self.language,
            initial_prompt=self.initial_prompt,
        )

    async def flush(self) -> dict | None:
        """Flush remaining audio buffer (called on stop). Waits for lock."""
        if self.buffer_samples == 0:
            return None

        # Wait for session lock — never silently drop tail sentence
        async with self._session_lock:
            if self.buffer_samples == 0:
                return None
            audio = np.concatenate(self.audio_buffer)
            buf_samples = self.buffer_samples
            self.audio_buffer = []
            self.buffer_samples = 0

            segments = await asyncio.to_thread(self._transcribe_sync, audio)

        # Timestamps from consumed audio base
        base_time = self.consumed_samples / SAMPLE_RATE
        self.consumed_samples += buf_samples

        if not segments:
            return None

        stable = []
        for seg in segments:
            text = seg.get("text", "").strip()
            if not text:
                continue
            self._segment_counter += 1
            seg_id = f"seg-{self._segment_counter}"
            seg_start = base_time + seg.get("start", 0.0)
            seg_end = base_time + seg.get("end", seg.get("start", 0.0))
            stable.append({
                "id": seg_id,
                "text": text,
                "start": round(seg_start, 2),
                "end": round(seg_end, 2),
            })

        if not stable:
            return None

        seq = self._next_seq()
        accepted = self.caption_state.accept({
            "sequence": seq,
            "stable": stable,
            "draft": "",
        })
        if not accepted:
            return None
        return {
            "type": "captions",
            "sequence": seq,
            "stable": accepted["stable"],
            "draft": accepted["draft"],
            "final": True,
        }

    def stop(self):
        self.running = False
