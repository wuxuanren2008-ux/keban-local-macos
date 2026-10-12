"""Local FastAPI runtime for Lecture Companion (课伴).

create_app(data_dir, web_dir, token) -> FastAPI
  • Loopback only (127.0.0.1)
  • X-Lecture-Token validation for all /api writes and private reads
  • Origin same-origin check (scheme + host + port), reject malicious Host
  • No permissive CORS
  • Static web_dir mounted at / last
"""

import asyncio
import base64
import io
import json
import logging
import os
import secrets
import struct
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from fastapi import (
    FastAPI,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
    HTTPException,
    status,
)
from fastapi.responses import JSONResponse, StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles

from desktop.storage import Storage, CourseNotFound
from desktop.ai import OllamaClient, AIService, ALLOWED_MODELS, OllamaError
from desktop.asr import ASRManager

logger = logging.getLogger(__name__)

MAX_AUDIO_BYTES = 512 * 1024 * 1024  # 512 MB local limit
MAX_JSON_BYTES = 10 * 1024 * 1024    # 10 MB JSON


# ---------------------------------------------------------------------------
# Security helpers
# ---------------------------------------------------------------------------

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _is_loopback(host: str | None) -> bool:
    """True if Host header is a loopback address (no external access)."""
    if not host:
        return False
    try:
        return urlparse('http://' + host).hostname in LOOPBACK_HOSTS
    except ValueError:
        return False


def _check_origin(request: Request) -> bool:
    """Verify Origin header is same-origin (scheme + host + port match loopback).

    Non-browser requests (no Origin header) are allowed if Host is loopback.
    """
    origin = request.headers.get("origin", "")
    if not origin:
        return True  # Non-browser request — Host check handles security
    try:
        parsed = urlparse(origin)
        expected = urlparse('http://' + request.headers.get('host', ''))
        return (parsed.scheme == 'http'
                and parsed.hostname == expected.hostname
                and parsed.hostname in LOOPBACK_HOSTS
                and (parsed.port or 80) == (expected.port or 80)
                and not parsed.username and not parsed.password
                and parsed.path in ('', '/') and not parsed.query and not parsed.fragment)
    except Exception:
        return False


def _verify_token_header(request: Request, token: str) -> bool:
    """Check X-Lecture-Token header only (NOT in query for HTTP requests)."""
    header = request.headers.get("x-lecture-token", "")
    return bool(header) and secrets.compare_digest(header, token)


def _verify_token_ws(websocket: WebSocket, token: str) -> bool:
    """For WebSocket only: token via query param is allowed."""
    qs = parse_qs(websocket.url.query)
    qtoken = qs.get("token", [""])[0]
    return bool(qtoken) and secrets.compare_digest(qtoken, token)


def _require_auth(request: Request, token: str):
    """Raise 403 if request lacks valid token, bad Host, or bad Origin."""
    if not _is_loopback(request.headers.get("host")):
        raise HTTPException(status_code=403, detail="Forbidden: non-loopback host")
    if not _check_origin(request):
        raise HTTPException(status_code=403, detail="Forbidden: cross-origin")
    if not _verify_token_header(request, token):
        raise HTTPException(status_code=403, detail="Invalid or missing token")


# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------

def create_app(data_dir: Path, web_dir: Path, token: str) -> FastAPI:
    app = FastAPI(
        title="Lecture Companion Local Runtime",
        docs_url=None, redoc_url=None, openapi_url=None,
    )

    storage = Storage(Path(data_dir))
    ollama = OllamaClient()
    ai = AIService(ollama)
    asr = ASRManager()
    stream_busy = False

    # Sync initial settings
    _sync_settings(storage, ai, asr)

    # ------------------------------------------------------------------
    # Middleware: reject non-loopback Host on every request
    # ------------------------------------------------------------------
    @app.middleware("http")
    async def security_middleware(request: Request, call_next):
        host = request.headers.get("host", "")
        if not _is_loopback(host):
            return JSONResponse(status_code=403,
                                content={"detail": "Forbidden: non-loopback host"})
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        return response

    # ------------------------------------------------------------------
    # Health
    # ------------------------------------------------------------------
    @app.get("/api/health")
    async def health(request: Request):
        _require_auth(request, token)
        # Read settings fresh — no closure staleness
        s = storage.get_settings()
        llm_ready = await asyncio.to_thread(ollama.is_ready)
        llm_models = await asyncio.to_thread(ollama.list_models) if llm_ready else []
        model_name = s.get("llm_model", "qwen3.5:4b")
        return {
            "ready": True,
            "asr": {
                "model": s.get("asr_model", "small"),
                "device": s.get("asr_device", "cpu"),
                "ready": asr.get_engine().ready,
            },
            "llm": {
                "model": model_name,
                "ready": llm_ready and model_name in llm_models,
                "models": llm_models,
            },
            "data_dir": str(data_dir),
        }

    # ------------------------------------------------------------------
    # Settings
    # ------------------------------------------------------------------
    @app.get("/api/settings")
    async def get_settings_endpoint(request: Request):
        _require_auth(request, token)
        return _settings_response(storage)

    @app.post("/api/settings")
    async def update_settings_endpoint(request: Request):
        _require_auth(request, token)
        body = await _read_json(request)
        updates = {}
        if "llm_model" in body:
            model = str(body["llm_model"])
            if model not in ALLOWED_MODELS:
                raise HTTPException(400, f"Model '{model}' not allowed. Allowed: {ALLOWED_MODELS}")
            updates["llm_model"] = model
        if "asr_model" in body:
            updates["asr_model"] = str(body["asr_model"])
        if "asr_device" in body:
            if sys.platform == 'darwin' and body['asr_device'] != 'cpu':
                raise HTTPException(400, 'macOS Whisper uses CPU; Apple GPU acceleration is provided by Ollama for the LLM')
            updates["asr_device"] = str(body["asr_device"])
        if "learning_enabled" in body:
            updates["learning_enabled"] = "true" if body["learning_enabled"] else "false"
        if updates:
            storage.update_settings(updates)
            _sync_settings(storage, ai, asr)
        return _settings_response(storage)

    # ------------------------------------------------------------------
    # Model pull
    # ------------------------------------------------------------------
    @app.post("/api/models/pull")
    async def pull_model(request: Request):
        _require_auth(request, token)
        body = await _read_json(request)
        model = body.get("model", "")
        if not model:
            raise HTTPException(400, "model is required")
        result = await asyncio.to_thread(ollama.pull_model, model)
        # Return non-200 on failure
        if result.get("status") != "success":
            return JSONResponse(status_code=502, content=result)
        return result

    # ------------------------------------------------------------------
    # AI operations
    # ------------------------------------------------------------------
    @app.post("/api/ai")
    async def ai_endpoint(request: Request):
        _require_auth(request, token)
        body = await _read_json(request, max_bytes=MAX_JSON_BYTES)
        operation = body.get("operation", "")
        course_id = body.get("course_id")

        # Read fresh settings for model
        s = storage.get_settings()
        ai = AIService(ollama)
        ai.set_model(s.get("llm_model", "qwen3.5:4b"))

        # Get glossary (respects learning_enabled in get_corrections_for_prompt)
        glossary = None
        if course_id:
            glossary = await asyncio.to_thread(
                storage.get_corrections_for_prompt, course_id
            )
            ai.course_feedback = await asyncio.to_thread(storage.feedback_for_prompt, course_id)

        if operation == "translate_lecture":
            result = await asyncio.to_thread(
                ai.translate_lecture,
                body.get("text", ""), body.get("source", "en"),
                body.get("target", "zh"), glossary,
            )
            return _ai_result_response(result)

        elif operation == "summarize":
            transcript = body.get("transcript", [])
            target_language = body.get("targetLanguage", "zh")
            result = await asyncio.to_thread(
                ai.summarize,
                body.get("title", ""), transcript, target_language, glossary,
            )
            # If summarize returned a mindmap, persist it with the lecture
            if course_id and "mindmap" in result and not result.get("error"):
                lecture_id = body.get("lecture_id")
                if lecture_id:
                    await asyncio.to_thread(
                        storage.update_lecture_mindmap, lecture_id, result["mindmap"]
                    )
            return _ai_result_response(result)

        elif operation == "translate_document":
            # PDF text extraction (local, no remote)
            pdf_text = None
            if body.get("pdf"):
                pdf_text = _extract_pdf_text(body["pdf"])
                if pdf_text is None:
                    raise HTTPException(
                        422, "PDF contains scanned pages or images — OCR is not supported locally. "
                             "Please convert to text-based PDF."
                    )
            result = await asyncio.to_thread(
                ai.translate_document,
                body.get("title", ""), body.get("language", "zh"),
                body.get("mode", "course"),
                {"text": body.get("text", ""), "pdf": body.get("pdf")},
                pdf_text,
            )
            return _ai_result_response(result)

        elif operation == "analyze_document":
            digests = body.get("digests", [])
            result = await asyncio.to_thread(
                ai.analyze_document,
                body.get("title", ""), body.get("language", "zh"),
                body.get("mode", "course"), digests,
            )
            return _ai_result_response(result)

        else:
            raise HTTPException(400, f"Unknown operation: {operation}")

    # ------------------------------------------------------------------
    # Courses
    # ------------------------------------------------------------------
    @app.get("/api/courses")
    async def list_courses(request: Request):
        _require_auth(request, token)
        return {"courses": storage.list_courses()}

    @app.post("/api/courses")
    async def create_course(request: Request):
        _require_auth(request, token)
        body = await _read_json(request)
        name = body.get("name", "")
        if not name:
            raise HTTPException(400, "name is required")
        return storage.create_course(name)

    # ------------------------------------------------------------------
    # Lectures
    # ------------------------------------------------------------------
    @app.get("/api/lectures")
    async def list_lectures(request: Request, course_id: str | None = None):
        _require_auth(request, token)
        # No course_id → return all lectures (frontend filters by course)
        return {"lectures": storage.list_lectures(course_id)}

    @app.post("/api/lectures")
    async def create_lecture(request: Request):
        _require_auth(request, token)
        body = await _read_json(request, max_bytes=MAX_JSON_BYTES)
        course_id = body.get("course_id", "")
        if not course_id:
            raise HTTPException(400, "course_id is required")
        snapshot = {k: v for k, v in body.items() if k != "course_id"}
        try:
            result = storage.upsert_lecture(course_id, snapshot)
        except CourseNotFound:
            raise HTTPException(404, "Course not found")
        return result

    @app.get("/api/lectures/{lecture_id}")
    async def get_lecture(request: Request, lecture_id: str):
        _require_auth(request, token)
        result = storage.get_lecture(lecture_id)
        if not result:
            raise HTTPException(404, "Lecture not found")
        return result

    @app.delete("/api/lectures/{lecture_id}")
    async def delete_lecture(request: Request, lecture_id: str):
        _require_auth(request, token)
        if not storage.delete_lecture(lecture_id):
            raise HTTPException(404, "Lecture not found")
        return {"deleted": True}

    # ------------------------------------------------------------------
    # Audio (streaming FileResponse, 512MB, atomic write)
    # ------------------------------------------------------------------
    @app.put("/api/lectures/{lecture_id}/audio")
    async def put_audio(request: Request, lecture_id: str):
        _require_auth(request, token)
        mime = request.headers.get("content-type", "audio/webm")
        if mime.split(';')[0] not in {'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'application/octet-stream'}:
            raise HTTPException(415, 'Unsupported recording format')
        if not storage.get_lecture(lecture_id):
            raise HTTPException(404, "Lecture not found")
        fd, temporary = tempfile.mkstemp(prefix='recording-', suffix='.tmp', dir=storage.audio_dir)
        total = 0
        try:
            with os.fdopen(fd, 'wb') as file:
                async for chunk in request.stream():
                    total += len(chunk)
                    if total > MAX_AUDIO_BYTES:
                        raise HTTPException(413, 'Recording exceeds 512 MB')
                    await asyncio.to_thread(file.write, chunk)
            if not total:
                raise HTTPException(400, 'Recording is empty')
            if not await asyncio.to_thread(storage.commit_audio_file, lecture_id, Path(temporary), mime):
                raise HTTPException(404, 'Lecture no longer exists')
        finally:
            Path(temporary).unlink(missing_ok=True)
        return {"saved": True}

    @app.get("/api/lectures/{lecture_id}/audio")
    async def get_audio(request: Request, lecture_id: str):
        _require_auth(request, token)
        path, mime = storage.get_audio_path(lecture_id)
        if path is None:
            raise HTTPException(404, "Audio not found")
        # Use FileResponse for streaming — avoids loading entire audio into memory
        return FileResponse(
            path=str(path),
            media_type=mime or "application/octet-stream",
            filename=f"{lecture_id}.bin",
        )

    # ------------------------------------------------------------------
    # Glossary / Corrections / Learning
    # ------------------------------------------------------------------
    @app.get("/api/glossary")
    async def get_glossary(request: Request, course_id: str = ""):
        _require_auth(request, token)
        if not course_id:
            raise HTTPException(400, "course_id is required")
        return {"terms": storage.list_glossary(course_id)}

    @app.post("/api/corrections")
    async def add_correction(request: Request):
        _require_auth(request, token)
        body = await _read_json(request)
        course_id = body.get("course_id", "")
        source_term = body.get("source_term", "")
        preferred_translation = body.get("preferred_translation", "")
        source_language = body.get("source_language", "en")
        target_language = body.get("target_language", "zh")
        if not course_id or not source_term or not preferred_translation:
            raise HTTPException(400, "course_id, source_term, preferred_translation required")
        try:
            return storage.add_correction(
                course_id, source_term, preferred_translation,
                source_language, target_language,
            )
        except CourseNotFound:
            raise HTTPException(404, "Course not found")

    @app.get("/api/learning")
    async def get_learning(request: Request, course_id: str = ""):
        _require_auth(request, token)
        if not course_id:
            raise HTTPException(400, "course_id is required")
        return storage.get_learning(course_id)

    @app.delete('/api/corrections')
    async def delete_correction(request: Request):
        _require_auth(request, token)
        body = await _read_json(request)
        if not body.get('course_id') or not body.get('source_term'):
            raise HTTPException(400, 'course_id and source_term required')
        storage.delete_correction(body['course_id'], body['source_term'],
                                  body.get('source_language', 'en'), body.get('target_language', 'zh-CN'))
        return {'deleted': True}

    @app.post('/api/feedback')
    async def add_feedback(request: Request):
        _require_auth(request, token)
        body = await _read_json(request)
        feedback = body.get('feedback', '')
        if not isinstance(feedback, str) or not feedback.strip() or len(feedback) > 2000:
            raise HTTPException(400, 'Feedback must contain 1–2000 characters')
        try:
            storage.add_feedback(body.get('course_id', ''), body.get('lecture_id', ''), feedback.strip())
        except CourseNotFound:
            raise HTTPException(404, 'Classroom does not belong to this course')
        return {'saved': True}

    @app.get("/api/learning/export")
    async def export_learning(request: Request, course_id: str = ""):
        _require_auth(request, token)
        if not course_id:
            raise HTTPException(400, "course_id is required")
        # Export real correction rows for future LoRA training
        rows = storage.export_learning(course_id)
        return {"course_id": course_id, "corrections": rows, "count": len(rows), 'summary_feedback': storage.list_feedback(course_id)}

    @app.post("/api/learning/reset")
    async def reset_learning(request: Request):
        _require_auth(request, token)
        body = await _read_json(request)
        course_id = body.get("course_id", "")
        if not course_id:
            raise HTTPException(400, "course_id is required")
        storage.reset_learning(course_id)
        return {"reset": True}

    # ------------------------------------------------------------------
    # WebSocket streaming
    # ------------------------------------------------------------------
    @app.websocket("/v1/stream")
    async def stream_endpoint(websocket: WebSocket):
        nonlocal stream_busy
        # Verify token via query param (WS allows query token)
        if not _verify_token_ws(websocket, token):
            await websocket.close(code=4001, reason="Invalid token")
            return

        # Verify same-origin via Host header
        if not _is_loopback(websocket.headers.get("host", "")):
            await websocket.close(code=4003, reason="Forbidden host")
            return

        # Verify Origin for browser connections
        if not _check_origin(websocket):
            await websocket.close(code=4003, reason="Forbidden origin")
            return

        await websocket.accept()
        if stream_busy:
            await websocket.send_json({'type': 'error', 'error': 'Whisper is busy with another classroom'})
            await websocket.close()
            return
        stream_busy = True

        from desktop.vendor.streaming_core import StreamingSession

        session = StreamingSession(websocket, asr, storage)

        try:
            while True:
                msg = await websocket.receive()

                if msg.get("text") is not None:
                    try:
                        data = json.loads(msg["text"])
                    except (json.JSONDecodeError, KeyError):
                        await websocket.send_json({"type": "error", "error": "Invalid JSON"})
                        continue

                    msg_type = data.get("type", "")
                    if msg_type == "start":
                        response = await session.handle_start(data)
                        await websocket.send_json(response)
                        if response.get("type") == "error":
                            break
                    elif msg_type == "stop":
                        captions = await session.flush()
                        if captions:
                            await websocket.send_json(captions)
                        break
                    else:
                        await websocket.send_json({"type": "error", "error": f"Unknown type: {msg_type}"})
                        break

                elif msg.get("bytes") is not None:
                    captions = await session.process_audio(msg["bytes"])
                    if captions:
                        await websocket.send_json(captions)

        except WebSocketDisconnect:
            logger.info("WebSocket disconnected")
        except Exception as exc:
            logger.error("WebSocket error: %s", exc)
            try:
                await websocket.send_json({"type": "error", "error": str(exc)})
            except Exception:
                pass
        finally:
            stream_busy = False
            session.stop()
            try:
                await websocket.close()
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Static files — mounted LAST so API routes take precedence
    # ------------------------------------------------------------------
    web_path = Path(web_dir)
    if web_path.exists() and web_path.is_dir():
        app.mount("/", StaticFiles(directory=str(web_path), html=True), name="web")

    return app


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def _sync_settings(storage: Storage, ai: AIService, asr: ASRManager):
    """Sync settings from storage to AI and ASR services."""
    s = storage.get_settings()
    model = s.get("llm_model", "qwen3.5:4b")
    if model in ALLOWED_MODELS:
        ai.set_model(model)
    asr.configure(
        s.get("asr_model", "small"),
        s.get("asr_device", "cpu"),
    )


def _settings_response(storage: Storage) -> dict:
    s = storage.get_settings()
    return {
        "llm_model": s.get("llm_model", "qwen3.5:4b"),
        "asr_model": s.get("asr_model", "small"),
        "asr_device": s.get("asr_device", "cpu"),
        "learning_enabled": s.get("learning_enabled", "true") == "true",
    }


def _ai_result_response(result: dict) -> Response:
    """Map AI result errors to proper HTTP status codes."""
    if result.get("error"):
        # 502 for upstream LLM errors, 422 for content errors
        err = result["error"]
        if "not in allowed" in err or "not allowed" in err:
            return JSONResponse(status_code=400, content=result)
        if "empty" in err.lower() or "invalid" in err.lower():
            return JSONResponse(status_code=422, content=result)
        return JSONResponse(status_code=502, content=result)
    return result


def _extract_pdf_text(pdf_base64: str) -> str | None:
    """Extract text from a base64-encoded PDF using pypdf (local only).
    Returns None if PDF has no extractable text (scanned pages)."""
    try:
        from pypdf import PdfReader
        raw = base64.b64decode(pdf_base64)
        reader = PdfReader(io.BytesIO(raw))
        text_parts = []
        for page in reader.pages:
            page_text = page.extract_text() or ""
            text_parts.append(page_text)
        full_text = "\n".join(text_parts).strip()
        if not full_text:
            return None  # Scanned PDF — no text
        return full_text
    except Exception as exc:
        logger.warning("PDF extraction failed: %s", exc)
        return None


async def _read_json(request: Request, max_bytes: int = MAX_JSON_BYTES) -> dict:
    body = await request.body()
    if len(body) > max_bytes:
        raise HTTPException(413, "Request body too large")
    try:
        return json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(400, "Invalid JSON body")
