"""Whisper ASR integration for local lecture companion.

Lazy-loads models on first use, supports CPU int8 quantisation,
and injects course-specific corrections as initial_prompt.
"""

import logging
import threading
import time
from typing import Any

logger = logging.getLogger(__name__)

# Model size mapping (mirrors whisper / faster-whisper conventions)
MODEL_SIZES = {"tiny", "base", "small", "medium", "large", "large-v2", "large-v3"}


class WhisperEngine:
    """Wraps faster-whisper (preferred) or openai-whisper as fallback."""

    def __init__(self, model_name: str = "small", device: str = "cpu"):
        self.model_name = model_name
        self.device = device
        self._model = None
        self._lock = threading.Lock()
        self._ready = False
        self._error: str | None = None

    @property
    def ready(self) -> bool:
        return self._ready

    @property
    def error(self) -> str | None:
        return self._error

    @property
    def model_info(self) -> dict:
        return {"model": self.model_name, "device": self.device, "ready": self._ready}

    def _load_model(self):
        """Lazy-load the Whisper model. Called inside _lock."""
        if self._model is not None:
            return
        try:
            # Prefer faster-whisper for int8 CPU support
            from faster_whisper import WhisperModel

            compute_type = "int8" if self.device == "cpu" else "float16"
            logger.info("Loading faster-whisper %s on %s (%s)",
                        self.model_name, self.device, compute_type)
            self._model = WhisperModel(
                self.model_name,
                device=self.device,
                compute_type=compute_type,
            )
            self._ready = True
            self._error = None
        except ImportError:
            try:
                import whisper

                logger.info("Loading openai-whisper %s on %s",
                            self.model_name, self.device)
                self._model = whisper.load_model(self.model_name, device=self.device)
                self._ready = True
                self._error = None
            except ImportError:
                self._error = (
                    "Whisper is not installed. Run: pip install faster-whisper "
                    "or pip install openai-whisper"
                )
                raise RuntimeError(self._error)
        except Exception as exc:
            # Model not downloaded yet
            msg = str(exc)
            if "model" in msg.lower() and ("download" in msg.lower() or "not found" in msg.lower()):
                self._error = (
                    f"Whisper model '{self.model_name}' is not downloaded. "
                    f"It will be fetched on first use, or install it manually."
                )
            else:
                self._error = f"Failed to load Whisper: {exc}"
            raise RuntimeError(self._error)

    def ensure_loaded(self):
        """Thread-safe lazy load. Blocks until model is ready or raises."""
        with self._lock:
            self._load_model()

    def is_model_available(self) -> bool:
        """Check if the model file is already downloaded (non-blocking)."""
        try:
            from faster_whisper.utils import download_model

            # This will not download if already cached
            download_model(self.model_name)
            return True
        except Exception:
            try:
                import whisper

                # openai-whisper caches in ~/.cache/whisper
                import os
                cache_dir = os.path.expanduser("~/.cache/whisper")
                return any(self.model_name in f for f in os.listdir(cache_dir)) if os.path.isdir(cache_dir) else False
            except Exception:
                return False

    def transcribe_segment(self, audio_data, language: str = "en",
                          initial_prompt: str = "") -> list[dict]:
        """Transcribe a chunk of float32 16kHz mono audio.

        Returns list of segments: [{start, end, text}].
        """
        self.ensure_loaded()
        segments = []
        if self._model is None:
            return segments

        try:
            if hasattr(self._model, "transcribe"):
                # faster-whisper
                result = self._model.transcribe(
                    audio_data,
                    language=language if language != "ms" else "ms",
                    initial_prompt=initial_prompt if initial_prompt else None,
                    vad_filter=True,
                    beam_size=5,
                )
                # faster-whisper returns (segments, info)
                if isinstance(result, tuple):
                    seg_iter = result[0]
                else:
                    seg_iter = result.segments if hasattr(result, "segments") else []
                for seg in seg_iter:
                    segments.append({
                        "start": getattr(seg, "start", 0.0),
                        "end": getattr(seg, "end", 0.0),
                        "text": getattr(seg, "text", "").strip(),
                    })
            else:
                # openai-whisper
                result = self._model.transcribe(
                    audio_data,
                    language=language if language != "ms" else None,
                    initial_prompt=initial_prompt if initial_prompt else None,
                )
                for seg in result.get("segments", []):
                    segments.append({
                        "start": seg.get("start", 0.0),
                        "end": seg.get("end", 0.0),
                        "text": seg.get("text", "").strip(),
                    })
        except Exception as exc:
            logger.error("Transcription error: %s", exc)
            raise
        return segments


class ASRManager:
    """Manages a single WhisperEngine instance with ASR lock and settings."""

    def __init__(self):
        self._engine: WhisperEngine | None = None
        self._asr_lock = threading.Lock()
        self._model_name = "small"
        self._device = "cpu"

    @property
    def info(self) -> dict:
        if self._engine:
            return self._engine.model_info
        return {"model": self._model_name, "device": self._device, "ready": False}

    def configure(self, model_name: str, device: str):
        if self._engine and (self._engine.model_name != model_name
                             or self._engine.device != device):
            # Discard old engine — new one loads on next use
            self._engine = None
        self._model_name = model_name
        self._device = device

    def get_engine(self) -> WhisperEngine:
        if self._engine is None:
            self._engine = WhisperEngine(self._model_name, self._device)
        return self._engine

    def try_lock(self) -> bool:
        return self._asr_lock.acquire(blocking=False)

    def unlock(self):
        try:
            self._asr_lock.release()
        except RuntimeError:
            pass

    def build_initial_prompt(self, corrections: list[dict]) -> str:
        """Build a Whisper initial_prompt from course-specific corrections."""
        if not corrections:
            return ""
        terms = [c["source_term"] for c in corrections[:50] if c.get("source_term")]
        return " ".join(terms)
