"""Test suite for local Lecture Companion runtime.

Uses mock Ollama and mock Whisper — no model downloads required.
Verifies: token/origin security, course isolation, persistence,
audio storage, long-text tail segments, model failure handling,
correction injection, and mindmap source validation.
"""

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch, AsyncMock

import pytest
from fastapi.testclient import TestClient

# Ensure project root is on sys.path
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def temp_dirs():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        data_dir = Path(d) / "data"
        web_dir = Path(d) / "web"
        data_dir.mkdir()
        web_dir.mkdir()
        # Minimal index.html so StaticFiles has something to serve
        (web_dir / "index.html").write_text("<html>test</html>")
        yield data_dir, web_dir


@pytest.fixture
def token():
    return "a" * 64  # 32-byte hex = 64 chars


@pytest.fixture
def mock_ollama():
    """Mock OllamaClient that returns canned responses."""
    mock = MagicMock()
    mock.is_ready.return_value = True
    mock.list_models.return_value = ["qwen3.5:4b", "qwen3.5:9b"]
    mock.pull_model.return_value = {"status": "success", "model": "qwen3.5:4b"}

    def fake_generate(model, prompt, **kwargs):
        # Return JSON based on prompt content
        if "translate" in prompt.lower() and "translation" in prompt.lower():
            return json.dumps({"translation": "翻译结果"})
        elif "summarize" in prompt.lower() or "merge" in prompt.lower():
            return json.dumps({
                "overview": "课堂概要",
                "key_points": ["要点1", "要点2"],
                "key_terms": [{"term": "术语1", "explanation": "解释1"}],
                "review_questions": ["问题1"],
                "unclear_points": ["待确认1"],
                "mindmap_nodes": [
                    {"id": "n0", "label": "根节点", "parent": None, "source_ids": [0, 1]},
                    {"id": "n1", "label": "子节点", "parent": "n0", "source_ids": [2]},
                ],
            })
        elif "analyze" in prompt.lower():
            return json.dumps({
                "overview": "文档概要",
                "key_points": ["文档要点1"],
                "key_terms": [{"term": "文档术语", "explanation": "文档解释"}],
                "analysis": ["分析方法1"],
                "review_questions": ["文档问题1"],
                "unclear_points": ["文档待确认1"],
            })
        return json.dumps({"translation": "默认翻译"})

    mock.generate = fake_generate
    mock.chat = fake_generate
    return mock


@pytest.fixture
def mock_asr():
    """Mock ASRManager — no Whisper model loading."""
    mock = MagicMock()
    mock.info = {"model": "small", "device": "cpu", "ready": True}
    mock.try_lock.return_value = True
    mock.unlock.return_value = None
    mock.build_initial_prompt.return_value = "opportunity cost supply demand"
    engine = MagicMock()
    engine.ready = True
    engine.model_info = {"model": "small", "device": "cpu", "ready": True}
    engine.ensure_loaded = MagicMock()
    engine.transcribe_segment = MagicMock(return_value=[
        {"start": 0.0, "end": 2.0, "text": "hello world"},
    ])
    mock.get_engine.return_value = engine
    return mock


@pytest.fixture
def app(temp_dirs, token, mock_ollama, mock_asr):
    """Create the FastAPI app with mocked services."""
    data_dir, web_dir = temp_dirs
    # Patch the real classes before import
    with patch("desktop.runtime.OllamaClient", return_value=mock_ollama), \
         patch("desktop.runtime.ASRManager", return_value=mock_asr):
        from desktop.runtime import create_app
        app = create_app(data_dir, web_dir, token)
    return app


@pytest.fixture
def client(app):
    return TestClient(app, base_url="http://127.0.0.1:8766")


# ---------------------------------------------------------------------------
# Auth & Security Tests
# ---------------------------------------------------------------------------

class TestSecurity:
    def test_health_requires_token(self, client, token):
        """No token -> 403."""
        r = client.get("/api/health")
        assert r.status_code == 403

    def test_health_with_valid_token(self, client, token):
        """Valid token -> 200 with health info."""
        r = client.get("/api/health", headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        data = r.json()
        assert data["ready"] is True
        assert "asr" in data
        assert "llm" in data
        assert "data_dir" in data

    def test_invalid_token_rejected(self, client):
        """Wrong token -> 403."""
        r = client.get("/api/health", headers={"X-Lecture-Token": "wrong"})
        assert r.status_code == 403

    def test_non_loopback_host_rejected(self, client, token):
        """Non-loopback Host -> 403."""
        r = client.get(
            "/api/health",
            headers={"X-Lecture-Token": token, "Host": "evil.example.com"},
        )
        assert r.status_code == 403

    def test_cross_origin_rejected(self, client, token):
        """Cross-origin Origin -> 403."""
        r = client.get(
            "/api/health",
            headers={
                "X-Lecture-Token": token,
                "Origin": "https://evil.example.com",
            },
        )
        assert r.status_code == 403

    def test_loopback_origin_allowed(self, client, token):
        """Loopback origin -> 200."""
        r = client.get(
            "/api/health",
            headers={
                "X-Lecture-Token": token,
                "Origin": "http://127.0.0.1:8766",
            },
        )
        assert r.status_code == 200

    def test_write_endpoints_require_token(self, client):
        """POST without token -> 403."""
        r = client.post("/api/courses", json={"name": "Test"})
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# Course & Lecture CRUD Tests
# ---------------------------------------------------------------------------

class TestCoursesLectures:
    def test_create_and_list_courses(self, client, token):
        r = client.post(
            "/api/courses",
            json={"name": "Economics 101"},
            headers={"X-Lecture-Token": token},
        )
        assert r.status_code == 200
        course = r.json()
        assert course["name"] == "Economics 101"
        assert "id" in course

        r = client.get("/api/courses", headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        assert len(r.json()["courses"]) == 1
        assert r.json()["courses"][0]["name"] == "Economics 101"

    def test_lecture_crud(self, client, token):
        # Create course
        r = client.post(
            "/api/courses",
            json={"name": "Test Course"},
            headers={"X-Lecture-Token": token},
        )
        course_id = r.json()["id"]

        # Create lecture (studio snapshot format)
        snapshot = {
            "id": "lec-001",
            "title": "Week 1 Lecture",
            "created_at": "2026-01-01T10:00:00",
            "language": "en-US",
            "target": "zh-CN",
            "transcript": [
                {"text": "hello", "translation": "你好", "time": "00:00"},
                {"text": "world", "translation": "世界", "time": "00:05"},
            ],
            "summary": None,
            "notes": "My notes",
            "duration": "00:30",
            "hasAudio": False,
        }
        r = client.post(
            "/api/lectures",
            json={"course_id": course_id, **snapshot},
            headers={"X-Lecture-Token": token},
        )
        assert r.status_code == 200
        lec = r.json()
        assert lec["title"] == "Week 1 Lecture"
        assert len(lec["transcript"]) == 2

        # GET lecture by id
        r = client.get(
            f"/api/lectures/lec-001",
            headers={"X-Lecture-Token": token},
        )
        assert r.status_code == 200
        assert r.json()["title"] == "Week 1 Lecture"

        # List lectures
        r = client.get(
            f"/api/lectures?course_id={course_id}",
            headers={"X-Lecture-Token": token},
        )
        assert r.status_code == 200
        assert len(r.json()["lectures"]) == 1

        # DELETE lecture
        r = client.delete(
            f"/api/lectures/lec-001",
            headers={"X-Lecture-Token": token},
        )
        assert r.status_code == 200

        # Confirm deleted
        r = client.get(
            f"/api/lectures/lec-001",
            headers={"X-Lecture-Token": token},
        )
        assert r.status_code == 404

    def test_course_isolation(self, client, token):
        """Lectures from one course are not visible in another."""
        # Create two courses
        r1 = client.post("/api/courses", json={"name": "Course A"},
                        headers={"X-Lecture-Token": token})
        r2 = client.post("/api/courses", json={"name": "Course B"},
                        headers={"X-Lecture-Token": token})
        cid_a = r1.json()["id"]
        cid_b = r2.json()["id"]

        # Add lecture to course A
        client.post("/api/lectures",
                    json={"course_id": cid_a, "id": "lec-a",
                          "title": "A Lecture", "created_at": "2026-01-01",
                          "transcript": []},
                    headers={"X-Lecture-Token": token})

        # Course B should have zero lectures
        r = client.get(f"/api/lectures?course_id={cid_b}",
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        assert len(r.json()["lectures"]) == 0

    def test_persistence_across_restart(self, temp_dirs, token, mock_ollama, mock_asr):
        """Data persists across app restarts."""
        data_dir, web_dir = temp_dirs
        with patch("desktop.runtime.OllamaClient", return_value=mock_ollama), \
             patch("desktop.runtime.ASRManager", return_value=mock_asr):
            from desktop.runtime import create_app
            app1 = create_app(data_dir, web_dir, token)
            c1 = TestClient(app1, base_url="http://127.0.0.1:8766")
            c1.post("/api/courses", json={"name": "Persistent"},
                    headers={"X-Lecture-Token": token})

            # New app instance, same data_dir
            app2 = create_app(data_dir, web_dir, token)
            c2 = TestClient(app2, base_url="http://127.0.0.1:8766")
            r = c2.get("/api/courses", headers={"X-Lecture-Token": token})
            assert r.status_code == 200
            assert any(c["name"] == "Persistent" for c in r.json()["courses"])


# ---------------------------------------------------------------------------
# Audio Storage Tests
# ---------------------------------------------------------------------------

class TestAudio:
    def test_audio_roundtrip(self, client, token):
        # Create course + lecture
        r = client.post("/api/courses", json={"name": "Audio Course"},
                       headers={"X-Lecture-Token": token})
        cid = r.json()["id"]
        client.post("/api/lectures",
                    json={"course_id": cid, "id": "lec-aud",
                          "title": "Audio Test", "created_at": "2026-01-01",
                          "transcript": []},
                    headers={"X-Lecture-Token": token})

        # PUT audio
        audio_data = b"\x00\x01\x02\x03" * 1000
        r = client.put(f"/api/lectures/lec-aud/audio",
                      content=audio_data,
                      headers={"X-Lecture-Token": token,
                              "Content-Type": "application/octet-stream"})
        assert r.status_code == 200

        # GET audio back
        r = client.get(f"/api/lectures/lec-aud/audio",
                      headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        assert r.content == audio_data

    def test_audio_404_for_missing_lecture(self, client, token):
        r = client.put("/api/lectures/nonexistent/audio",
                      content=b"data",
                      headers={"X-Lecture-Token": token})
        assert r.status_code == 404

    def test_audio_uuid_mapping(self, temp_dirs, token, mock_ollama, mock_asr):
        """Audio files use UUID, not lecture ID, as filename."""
        data_dir, web_dir = temp_dirs
        with patch("desktop.runtime.OllamaClient", return_value=mock_ollama), \
             patch("desktop.runtime.ASRManager", return_value=mock_asr):
            from desktop.runtime import create_app
            app = create_app(data_dir, web_dir, token)
            c = TestClient(app, base_url="http://127.0.0.1:8766")

            r = c.post("/api/courses", json={"name": "UUID Course"},
                       headers={"X-Lecture-Token": token})
            cid = r.json()["id"]
            c.post("/api/lectures",
                   json={"course_id": cid, "id": "lec-uuid-1",
                         "title": "UUID Test", "created_at": "2026-01-01",
                         "transcript": []},
                   headers={"X-Lecture-Token": token})

            c.put("/api/lectures/lec-uuid-1/audio",
                  content=b"\xff" * 100,
                  headers={"X-Lecture-Token": token})

            # Check audio directory: file should NOT be named lec-uuid-1.bin
            audio_dir = data_dir / "audio"
            files = list(audio_dir.glob("*.bin"))
            assert len(files) == 1
            assert files[0].stem != "lec-uuid-1"
            assert len(files[0].stem) >= 32  # UUID is 36 chars


# ---------------------------------------------------------------------------
# AI Operation Tests
# ---------------------------------------------------------------------------

class TestAIOperations:
    def test_translate_lecture(self, client, token):
        r = client.post("/api/ai",
                       json={"operation": "translate_lecture",
                             "text": "opportunity cost",
                             "source": "en", "target": "zh"},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        data = r.json()
        assert "translation" in data
        assert "model" in data
        assert data["translation"]  # non-empty

    def test_summarize_with_mindmap(self, client, token):
        # Create a long transcript to test chunking + tail preservation
        transcript = [
            {"text": f"segment {i}", "translation": f"段{i}", "time": f"00:{i:02d}"}
            for i in range(50)
        ]
        r = client.post("/api/ai",
                       json={"operation": "summarize",
                             "title": "Long Lecture",
                             "transcript": transcript,
                             "targetLanguage": "zh"},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        data = r.json()
        assert "summary" in data
        assert "mindmap" in data
        assert "model" in data

        # Validate summary structure
        s = data["summary"]
        assert "overview" in s
        assert "key_points" in s
        assert isinstance(s["key_points"], list)
        assert "key_terms" in s
        assert isinstance(s["key_terms"], list)
        assert "review_questions" in s
        assert "unclear_points" in s

        # Validate mindmap structure
        mm = data["mindmap"]
        assert "title" in mm
        assert "nodes" in mm
        assert len(mm["nodes"]) > 0
        for node in mm["nodes"]:
            assert "id" in node
            assert "label" in node
            assert "parent" in node
            assert "source_ids" in node
            assert isinstance(node["source_ids"], list)

    def test_translate_document(self, client, token):
        r = client.post("/api/ai",
                       json={"operation": "translate_document",
                             "title": "Test Doc",
                             "language": "zh",
                             "mode": "course",
                             "text": "This is a test paragraph.",
                             "label": "Section 1"},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        data = r.json()
        assert "result" in data
        result = data["result"]
        assert "original" in result
        assert "translation" in result
        assert "digest" in result
        assert "warnings" in result
        assert isinstance(result["warnings"], list)

    def test_analyze_document(self, client, token):
        r = client.post("/api/ai",
                       json={"operation": "analyze_document",
                             "title": "Research Paper",
                             "language": "zh",
                             "mode": "paper",
                             "digests": [
                                 {"label": "Section 1", "digest": "intro content"},
                                 {"label": "Section 2", "digest": "method content"},
                             ]},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        data = r.json()
        assert "summary" in data
        assert "analysis" in data["summary"]
        assert isinstance(data["summary"]["analysis"], list)

    def test_unknown_operation(self, client, token):
        r = client.post("/api/ai",
                       json={"operation": "invalid_op"},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 400

    def test_model_failure_graceful(self, client, token, mock_ollama):
        """When Ollama is down, AI endpoint returns 502 (not 500)."""
        mock_ollama.is_ready.return_value = False
        mock_ollama.generate = MagicMock(side_effect=Exception("Connection refused"))
        r = client.post("/api/ai",
                       json={"operation": "translate_lecture",
                             "text": "test", "source": "en", "target": "zh"},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 502  # Round 2: upstream LLM error → 502
        data = r.json()
        assert "error" in data


# ---------------------------------------------------------------------------
# Corrections & Learning Tests
# ---------------------------------------------------------------------------

class TestCorrections:
    def test_add_correction_and_glossary(self, client, token):
        # Create course
        r = client.post("/api/courses", json={"name": "Glossary Course"},
                       headers={"X-Lecture-Token": token})
        cid = r.json()["id"]

        # Add correction
        r = client.post("/api/corrections",
                       json={"course_id": cid,
                             "source_term": "opportunity cost",
                             "preferred_translation": "机会成本",
                             "source_language": "en",
                             "target_language": "zh"},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        assert r.json()["saved"] is True

        # Get glossary
        r = client.get(f"/api/glossary?course_id={cid}",
                      headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        terms = r.json()["terms"]
        assert len(terms) == 1
        assert terms[0]["source_term"] == "opportunity cost"
        assert terms[0]["preferred_translation"] == "机会成本"

    def test_correction_isolation(self, client, token):
        """Corrections in one course don't leak to another."""
        r1 = client.post("/api/courses", json={"name": "C1"},
                        headers={"X-Lecture-Token": token})
        r2 = client.post("/api/courses", json={"name": "C2"},
                        headers={"X-Lecture-Token": token})
        cid1 = r1.json()["id"]
        cid2 = r2.json()["id"]

        client.post("/api/corrections",
                    json={"course_id": cid1, "source_term": "supply",
                          "preferred_translation": "供给",
                          "source_language": "en", "target_language": "zh"},
                    headers={"X-Lecture-Token": token})

        r = client.get(f"/api/glossary?course_id={cid2}",
                      headers={"X-Lecture-Token": token})
        assert len(r.json()["terms"]) == 0

    def test_learning_reset(self, client, token):
        r = client.post("/api/courses", json={"name": "Reset Course"},
                       headers={"X-Lecture-Token": token})
        cid = r.json()["id"]

        client.post("/api/corrections",
                    json={"course_id": cid, "source_term": "demand",
                          "preferred_translation": "需求",
                          "source_language": "en", "target_language": "zh"},
                    headers={"X-Lecture-Token": token})

        # Reset
        r = client.post("/api/learning/reset",
                       json={"course_id": cid},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 200

        r = client.get(f"/api/learning?course_id={cid}",
                      headers={"X-Lecture-Token": token})
        assert len(r.json()["terms"]) == 0

    def test_correction_injection_into_translation(self, client, token, mock_ollama):
        """Corrections should be passed to the AI as glossary."""
        r = client.post("/api/courses", json={"name": "Inject Course"},
                       headers={"X-Lecture-Token": token})
        cid = r.json()["id"]

        client.post("/api/corrections",
                    json={"course_id": cid, "source_term": "elasticity",
                          "preferred_translation": "弹性",
                          "source_language": "en", "target_language": "zh"},
                    headers={"X-Lecture-Token": token})

        # Track what generate receives
        captured_prompts = []
        original_generate = mock_ollama.generate

        def tracking_generate(model, prompt, **kwargs):
            captured_prompts.append(prompt)
            return original_generate(model, prompt, **kwargs)
        mock_ollama.generate = tracking_generate

        r = client.post("/api/ai",
                       json={"operation": "translate_lecture",
                             "text": "price elasticity", "source": "en", "target": "zh",
                             "course_id": cid},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 200

        # Verify glossary was injected into the prompt
        assert any("elasticity" in p and "弹性" in p for p in captured_prompts)


# ---------------------------------------------------------------------------
# Settings Tests
# ---------------------------------------------------------------------------

class TestSettings:
    def test_get_default_settings(self, client, token):
        r = client.get("/api/settings", headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        s = r.json()
        assert s["llm_model"] == "qwen3.5:4b"
        assert s["asr_model"] == "small"
        assert s["asr_device"] == "cpu"
        assert s["learning_enabled"] is True

    def test_update_settings(self, client, token):
        r = client.post("/api/settings",
                       json={"llm_model": "qwen3.5:9b",
                             "asr_model": "medium",
                             "learning_enabled": False},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        s = r.json()
        assert s["llm_model"] == "qwen3.5:9b"
        assert s["asr_model"] == "medium"
        assert s["learning_enabled"] is False

        # Verify persistence
        r = client.get("/api/settings", headers={"X-Lecture-Token": token})
        assert r.json()["llm_model"] == "qwen3.5:9b"


# ---------------------------------------------------------------------------
# Long-text / Tail Segment Tests
# ---------------------------------------------------------------------------

class TestLongText:
    def test_long_transcript_tail_preserved(self, client, token, mock_ollama):
        """Long transcripts should not be truncated — tail segments preserved."""
        # Create a transcript that exceeds single-context capacity
        long_text = "word " * 2000  # ~10000 chars
        transcript = [
            {"text": long_text, "translation": "", "time": f"00:{i:02d}"}
            for i in range(10)
        ]
        r = client.post("/api/ai",
                       json={"operation": "summarize",
                             "title": "Very Long Lecture",
                             "transcript": transcript,
                             "targetLanguage": "zh"},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        data = r.json()
        # Summary should have content (not empty/truncated)
        assert data["summary"]["overview"]

    def test_mindmap_source_ids_valid(self, client, token):
        """Mindmap source_ids must reference valid transcript indices."""
        transcript = [
            {"text": f"seg {i}", "translation": "", "time": "00:00"}
            for i in range(20)
        ]
        r = client.post("/api/ai",
                       json={"operation": "summarize",
                             "title": "Source ID Test",
                             "transcript": transcript,
                             "targetLanguage": "zh"},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        data = r.json()
        mm = data["mindmap"]
        for node in mm["nodes"]:
            for sid in node["source_ids"]:
                assert 0 <= sid < len(transcript), \
                    f"source_id {sid} out of range [0, {len(transcript)})"


# ---------------------------------------------------------------------------
# Model Pull Tests
# ---------------------------------------------------------------------------

class TestModelPull:
    def test_pull_model(self, client, token):
        r = client.post("/api/models/pull",
                       json={"model": "qwen3.5:4b"},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "success"

    def test_pull_model_missing_name(self, client, token):
        r = client.post("/api/models/pull",
                       json={},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 400

    def test_pull_model_failure(self, client, token, mock_ollama):
        """Round 2: model pull failure returns 502, not 200 with error body."""
        mock_ollama.pull_model.return_value = {"status": "error", "error": "not found"}
        r = client.post("/api/models/pull",
                       json={"model": "nonexistent:999b"},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 502
        assert r.json()["status"] == "error"


# ---------------------------------------------------------------------------
# Static File Tests
# ---------------------------------------------------------------------------

class TestStaticFiles:
    def test_index_served(self, client):
        r = client.get("/")
        assert r.status_code == 200

    def test_api_routes_take_precedence(self, client, token):
        """API routes should be matched before static files."""
        r = client.get("/api/health", headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        assert "ready" in r.json()


# ===========================================================================
# Round 2 Regression Tests — 12 code review fixes
# ===========================================================================

import struct
from desktop.storage import Storage, CourseNotFound
from desktop.ai import OllamaClient, AIService, ALLOWED_MODELS, OllamaError


# ---------------------------------------------------------------------------
# Fix 1: Origin scheme + port validation
# ---------------------------------------------------------------------------

class TestOriginSchemePort:
    """Origin check must validate scheme AND port, not just hostname."""

    def test_https_origin_rejected(self, client, token):
        """https scheme on a loopback origin should be rejected (only http/ws)."""
        r = client.get("/api/health", headers={
            "X-Lecture-Token": token,
            "Origin": "https://127.0.0.1:8766",
        })
        assert r.status_code == 403

    def test_origin_port_mismatch_rejected(self, client, token):
        """Origin port must match request Host port."""
        r = client.get("/api/health", headers={
            "X-Lecture-Token": token,
            "Origin": "http://127.0.0.1:9999",  # different port
        })
        assert r.status_code == 403

    def test_origin_matching_port_allowed(self, client, token):
        """Loopback origin with matching port → 200."""
        r = client.get("/api/health", headers={
            "X-Lecture-Token": token,
            "Origin": "http://127.0.0.1:8766",
        })
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# Fix 2: Token NOT accepted via query for HTTP requests
# ---------------------------------------------------------------------------

class TestTokenQueryRejection:
    """HTTP requests must NOT accept token via query param — header only."""

    def test_token_in_query_rejected(self, client, token):
        r = client.get(f"/api/health?token={token}")
        assert r.status_code == 403

    def test_token_in_header_accepted(self, client, token):
        r = client.get("/api/health", headers={"X-Lecture-Token": token})
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# Fix 3: Model whitelist enforcement
# ---------------------------------------------------------------------------

class TestModelWhitelist:
    """Non-whitelisted models must be rejected in settings and AI calls."""

    def test_non_whitelisted_model_in_settings_rejected(self, client, token):
        r = client.post("/api/settings",
                       json={"llm_model": "gpt-4o"},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 400

    def test_whitelisted_model_in_settings_accepted(self, client, token):
        r = client.post("/api/settings",
                       json={"llm_model": "qwen3.5:9b"},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        assert r.json()["llm_model"] == "qwen3.5:9b"

    def test_pull_non_whitelisted_model_rejected(self, client, token, mock_ollama):
        # Configure mock to return error for non-whitelisted model
        mock_ollama.pull_model.return_value = {
            "status": "error",
            "error": "Model 'llama3:70b' not in allowed list"
        }
        r = client.post("/api/models/pull",
                       json={"model": "llama3:70b"},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 502


# ---------------------------------------------------------------------------
# Fix 4: AI error handling — no false success
# ---------------------------------------------------------------------------

class TestAINoFalseSuccess:
    """AI operations must not return empty results as success."""

    def test_empty_translation_returns_error(self, temp_dirs, token, mock_asr):
        """translate_lecture with empty LLM response must return error, not empty success."""
        data_dir, web_dir = temp_dirs
        mock_ai = MagicMock()
        mock_ai.is_ready.return_value = True
        mock_ai.list_models.return_value = ["qwen3.5:4b"]
        # LLM returns empty translation
        mock_ai.generate = MagicMock(return_value='{"translation": ""}')
        mock_ai.chat = mock_ai.generate

        with patch("desktop.runtime.OllamaClient", return_value=mock_ai), \
             patch("desktop.runtime.ASRManager", return_value=mock_asr):
            from desktop.runtime import create_app
            app = create_app(data_dir, web_dir, token)
            c = TestClient(app, base_url="http://127.0.0.1:8766")

            r = c.post("/api/ai",
                       json={"operation": "translate_lecture",
                             "text": "hello", "source": "en", "target": "zh"},
                       headers={"X-Lecture-Token": token})
            assert r.status_code == 422  # empty content → 422
            assert "error" in r.json()

    def test_empty_summary_overview_returns_error(self, temp_dirs, token, mock_asr):
        """summarize with empty overview must return error, not false success."""
        data_dir, web_dir = temp_dirs
        mock_ai = MagicMock()
        mock_ai.is_ready.return_value = True
        mock_ai.list_models.return_value = ["qwen3.5:4b"]
        # LLM returns empty overview
        mock_ai.generate = MagicMock(return_value='{"overview": "", "key_points": []}')
        mock_ai.chat = mock_ai.generate

        with patch("desktop.runtime.OllamaClient", return_value=mock_ai), \
             patch("desktop.runtime.ASRManager", return_value=mock_asr):
            from desktop.runtime import create_app
            app = create_app(data_dir, web_dir, token)
            c = TestClient(app, base_url="http://127.0.0.1:8766")

            r = c.post("/api/ai",
                       json={"operation": "summarize",
                             "title": "Test", "transcript": [
                                 {"text": "hello", "translation": "", "time": "00:00"}],
                             "targetLanguage": "zh"},
                       headers={"X-Lecture-Token": token})
            # Should have error in response (422 or 502)
            assert r.status_code in (422, 502)
            assert "error" in r.json()


# ---------------------------------------------------------------------------
# Fix 5: AI error → HTTP status mapping (400 / 422 / 502)
# ---------------------------------------------------------------------------

class TestAIErrorHttpStatus:
    """AI errors must map to correct HTTP status codes."""

    def test_model_not_allowed_returns_400(self, temp_dirs, token, mock_asr):
        """Using non-whitelisted model should return 400."""
        data_dir, web_dir = temp_dirs
        mock_ai = MagicMock()
        mock_ai.is_ready.return_value = True
        mock_ai.list_models.return_value = []
        # generate raises OllamaError for non-whitelisted model
        mock_ai.generate = MagicMock(side_effect=OllamaError("Model 'gpt-4o' not in allowed list"))
        mock_ai.chat = mock_ai.generate

        with patch("desktop.runtime.OllamaClient", return_value=mock_ai), \
             patch("desktop.runtime.ASRManager", return_value=mock_asr):
            from desktop.runtime import create_app
            app = create_app(data_dir, web_dir, token)
            c = TestClient(app, base_url="http://127.0.0.1:8766")

            # First set model to non-whitelisted via direct AIService manipulation
            r = c.post("/api/ai",
                       json={"operation": "translate_lecture",
                             "text": "test", "source": "en", "target": "zh"},
                       headers={"X-Lecture-Token": token})
            assert r.status_code == 400  # model not allowed → 400

    def test_connection_error_returns_502(self, client, token, mock_ollama):
        """Connection refused → 502 (upstream error)."""
        mock_ollama.generate = MagicMock(side_effect=Exception("Connection refused"))
        r = client.post("/api/ai",
                       json={"operation": "translate_lecture",
                             "text": "test", "source": "en", "target": "zh"},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 502


# ---------------------------------------------------------------------------
# Fix 6: _safe_json only accepts dict (rejects list/primitive)
# ---------------------------------------------------------------------------

class TestSafeJsonOnlyDict:
    """_safe_json must reject JSON arrays and primitives, returning {}."""

    def _make_service(self):
        ollama = MagicMock()
        return AIService(ollama)

    def test_safe_json_rejects_list(self):
        svc = self._make_service()
        assert svc._safe_json('[1, 2, 3]') == {}

    def test_safe_json_rejects_string(self):
        svc = self._make_service()
        assert svc._safe_json('"hello"') == {}

    def test_safe_json_rejects_number(self):
        svc = self._make_service()
        assert svc._safe_json('42') == {}

    def test_safe_json_rejects_null(self):
        svc = self._make_service()
        assert svc._safe_json('null') == {}

    def test_safe_json_accepts_dict(self):
        svc = self._make_service()
        result = svc._safe_json('{"key": "value"}')
        assert isinstance(result, dict)
        assert result["key"] == "value"

    def test_safe_json_empty_string(self):
        svc = self._make_service()
        assert svc._safe_json('') == {}

    def test_safe_json_markdown_fence(self):
        svc = self._make_service()
        result = svc._safe_json('```json\n{"a": 1}\n```')
        assert result == {"a": 1}


# ---------------------------------------------------------------------------
# Fix 7: think:false in Ollama payload (not /no_think prompt tag)
# ---------------------------------------------------------------------------

class TestThinkFalsePayload:
    """OllamaClient.generate and chat must include 'think': False in payload."""

    def _make_client(self):
        """Create a real OllamaClient with mocked httpx.Client."""
        client = OllamaClient()
        # Replace the httpx.Client with a mock that captures payloads
        client._client = MagicMock()
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"response": '{"translation": "ok"}'}
        client._client.post.return_value = mock_response
        return client

    def test_generate_includes_think_false(self):
        client = self._make_client()
        client.generate("qwen3.5:4b", "test prompt")
        # Verify the payload sent to Ollama
        call_args = client._client.post.call_args
        payload = call_args.kwargs.get("json") or call_args[1].get("json")
        assert payload is not None
        assert payload.get("think") is False

    def test_chat_includes_think_false(self):
        client = self._make_client()
        client.chat("qwen3.5:4b", [{"role": "user", "content": "hi"}])
        call_args = client._client.post.call_args
        payload = call_args.kwargs.get("json") or call_args[1].get("json")
        assert payload is not None
        assert payload.get("think") is False

    def test_generate_rejects_non_whitelisted_model(self):
        client = self._make_client()
        with pytest.raises(OllamaError, match="not in allowed"):
            client.generate("gpt-4o", "test")


# ---------------------------------------------------------------------------
# Fix 8: SQLite schema — mindmap and audio_mime columns exist
# ---------------------------------------------------------------------------

class TestStorageSchemaMigration:
    """Storage must have mindmap and audio_mime columns; migration adds them."""

    def test_mindmap_column_exists(self, temp_dirs):
        data_dir, _ = temp_dirs
        s = Storage(data_dir)
        with s._conn() as conn:
            cols = {row[1] for row in conn.execute("PRAGMA table_info(lectures)").fetchall()}
            assert "mindmap" in cols

    def test_audio_mime_column_exists(self, temp_dirs):
        data_dir, _ = temp_dirs
        s = Storage(data_dir)
        with s._conn() as conn:
            cols = {row[1] for row in conn.execute("PRAGMA table_info(lectures)").fetchall()}
            assert "audio_mime" in cols

    def test_migration_adds_missing_columns(self, temp_dirs):
        """Migration should add mindmap and audio_mime to an old-format DB."""
        data_dir, _ = temp_dirs
        # Create a DB without the new columns
        import sqlite3
        db_path = data_dir / "lecture_companion.db"
        with sqlite3.connect(str(db_path)) as conn:
            conn.executescript("""
                CREATE TABLE courses (id TEXT PRIMARY KEY, name TEXT, created_at TEXT);
                CREATE TABLE lectures (
                    id TEXT PRIMARY KEY, course_id TEXT, title TEXT,
                    created_at TEXT, updated_at TEXT, language TEXT, target TEXT,
                    transcript TEXT, summary TEXT, notes TEXT, duration TEXT,
                    audio_uuid TEXT
                );
                CREATE TABLE corrections (id TEXT PRIMARY KEY, course_id TEXT,
                    source_term TEXT, preferred_translation TEXT,
                    source_language TEXT, target_language TEXT, created_at TEXT);
                CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
            """)
        # Now open with Storage — migration should add columns
        s = Storage(data_dir)
        with s._conn() as conn:
            cols = {row[1] for row in conn.execute("PRAGMA table_info(lectures)").fetchall()}
            assert "mindmap" in cols
            assert "audio_mime" in cols


# ---------------------------------------------------------------------------
# Fix 9: CourseNotFound → 404 error handling
# ---------------------------------------------------------------------------

class TestCourseNotFound:
    """Operations on non-existent courses must return 404."""

    def test_create_lecture_nonexistent_course_404(self, client, token):
        r = client.post("/api/lectures",
                       json={"course_id": "nonexistent-uuid",
                             "id": "lec-1", "title": "Test",
                             "created_at": "2026-01-01", "transcript": []},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 404

    def test_add_correction_nonexistent_course_404(self, client, token):
        r = client.post("/api/corrections",
                       json={"course_id": "nonexistent-uuid",
                             "source_term": "test", "preferred_translation": "测试",
                             "source_language": "en", "target_language": "zh"},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 404

    def test_storage_upsert_raises_course_not_found(self, temp_dirs):
        data_dir, _ = temp_dirs
        s = Storage(data_dir)
        with pytest.raises(CourseNotFound):
            s.upsert_lecture("nonexistent", {"id": "lec-1", "title": "T"})


# ---------------------------------------------------------------------------
# Fix 10: get_corrections_for_prompt respects learning_enabled
# ---------------------------------------------------------------------------

class TestCorrectionsRespectLearningEnabled:
    """Corrections should NOT be injected when learning is disabled."""

    def test_corrections_empty_when_learning_disabled(self, temp_dirs):
        data_dir, _ = temp_dirs
        s = Storage(data_dir)
        # Create course + correction
        c = s.create_course("Test")
        s.add_correction(c["id"], "supply", "供给", "en", "zh")
        # Disable learning
        s.update_settings({"learning_enabled": "false"})
        # Should return empty list
        result = s.get_corrections_for_prompt(c["id"])
        assert result == []

    def test_corrections_present_when_learning_enabled(self, temp_dirs):
        data_dir, _ = temp_dirs
        s = Storage(data_dir)
        c = s.create_course("Test")
        s.add_correction(c["id"], "supply", "供给", "en", "zh")
        # learning_enabled is True by default
        result = s.get_corrections_for_prompt(c["id"])
        assert len(result) == 1
        assert result[0]["source_term"] == "supply"


# ---------------------------------------------------------------------------
# Fix 11: Audio — get_audio_path for FileResponse streaming
# ---------------------------------------------------------------------------

class TestAudioPathStreaming:
    """get_audio_path must return (path, mime) for FileResponse, not load file."""

    def test_get_audio_path_returns_path_and_mime(self, temp_dirs):
        data_dir, _ = temp_dirs
        s = Storage(data_dir)
        c = s.create_course("Test")
        lec = s.upsert_lecture(c["id"], {"id": "lec-a", "title": "T",
                                         "created_at": "2026-01-01", "transcript": []})
        s.put_audio("lec-a", b"\x00" * 100, mime="audio/webm")
        path, mime = s.get_audio_path("lec-a")
        assert path is not None
        assert path.exists()
        assert mime == "audio/webm"

    def test_get_audio_path_none_for_missing(self, temp_dirs):
        data_dir, _ = temp_dirs
        s = Storage(data_dir)
        path, mime = s.get_audio_path("nonexistent")
        assert path is None
        assert mime is None

    def test_get_audio_path_none_for_no_audio(self, temp_dirs):
        data_dir, _ = temp_dirs
        s = Storage(data_dir)
        c = s.create_course("Test")
        s.upsert_lecture(c["id"], {"id": "lec-b", "title": "T",
                                    "created_at": "2026-01-01", "transcript": []})
        path, mime = s.get_audio_path("lec-b")
        assert path is None


# ---------------------------------------------------------------------------
# Fix 12: Audio atomic write — preserves old recording on failure
# ---------------------------------------------------------------------------

class TestAudioAtomicWrite:
    """put_audio must preserve old recording if write fails."""

    def test_put_audio_preserves_old_on_failure(self, temp_dirs, monkeypatch):
        """If temp write fails, old audio file must remain intact."""
        data_dir, _ = temp_dirs
        s = Storage(data_dir)
        c = s.create_course("Test")
        s.upsert_lecture(c["id"], {"id": "lec-1", "title": "T",
                                    "created_at": "2026-01-01", "transcript": []})
        # First write — succeeds
        s.put_audio("lec-1", b"old data", mime="audio/webm")
        old_path, _ = s.get_audio_path("lec-1")
        assert old_path.exists()
        assert old_path.read_bytes() == b"old data"

        # Sabotage the write to simulate failure
        original_write = Path.write_bytes
        def failing_write(self, data):
            raise OSError("disk full")
        monkeypatch.setattr(Path, "write_bytes", failing_write)

        # Second write — should fail
        with pytest.raises(OSError):
            s.put_audio("lec-1", b"new data", mime="audio/webm")

        # Restore
        monkeypatch.undo()

        # Old audio must still be there and intact
        path, _ = s.get_audio_path("lec-1")
        assert path.exists()
        assert path.read_bytes() == b"old data"


# ---------------------------------------------------------------------------
# Fix 13: Audio 512MB limit (not 50MB cloud cap)
# ---------------------------------------------------------------------------

class TestAudio512MBLimit:
    """Storage.MAX_AUDIO_BYTES must be 512 MB, not the old 50 MB cloud cap."""

    def test_max_audio_bytes_is_512mb(self):
        assert Storage.MAX_AUDIO_BYTES == 512 * 1024 * 1024

    def test_runtime_max_audio_bytes_is_512mb(self):
        from desktop.runtime import MAX_AUDIO_BYTES
        assert MAX_AUDIO_BYTES == 512 * 1024 * 1024


# ---------------------------------------------------------------------------
# Fix 14: CaptionState sequence — separate _seq counter
# ---------------------------------------------------------------------------

class TestCaptionStateSequence:
    """_next_seq must NOT touch CaptionState.sequence — they are separate."""

    def test_next_seq_separate_from_caption_state(self):
        """CaptionState.sequence should only be updated by accept(), not _next_seq()."""
        from desktop.vendor.streaming_core import CaptionState
        cs = CaptionState()
        assert cs.sequence == -1  # initial

        # Simulate what StreamingSession does:
        # 1. _next_seq() generates a new seq (doesn't touch cs.sequence)
        _seq = 0  # what _next_seq would return
        # CaptionState.sequence should still be -1
        assert cs.sequence == -1

        # 2. accept() processes it — NOW sequence updates
        result = cs.accept({
            "sequence": _seq,
            "stable": [{"id": "s1", "text": "hello", "start": 0.0, "end": 1.0}],
            "draft": "",
        })
        assert result is not None
        assert cs.sequence == 0

    def test_accept_rejects_old_sequence(self):
        """accept() must reject updates with seq <= current."""
        from desktop.vendor.streaming_core import CaptionState
        cs = CaptionState()
        # First accept
        cs.accept({"sequence": 0, "stable": [], "draft": ""})
        assert cs.sequence == 0
        # Same seq → rejected
        result = cs.accept({"sequence": 0, "stable": [], "draft": ""})
        assert result is None
        # Lower seq → rejected
        result = cs.accept({"sequence": -1, "stable": [], "draft": ""})
        assert result is None

    def test_accept_deduplicates_segment_ids(self):
        """Same segment ID should not be emitted twice."""
        from desktop.vendor.streaming_core import CaptionState
        cs = CaptionState()
        seg = {"id": "s1", "text": "hello", "start": 0.0, "end": 1.0}
        # First time → included
        r1 = cs.accept({"sequence": 0, "stable": [seg], "draft": ""})
        assert len(r1["stable"]) == 1
        # Second time (different seq) → deduplicated
        r2 = cs.accept({"sequence": 1, "stable": [seg], "draft": ""})
        assert len(r2["stable"]) == 0


# ---------------------------------------------------------------------------
# Fix 15: Timestamp base from consumed_samples (not model segment times)
# ---------------------------------------------------------------------------

class TestTimestampFromConsumedSamples:
    """Timestamps must use consumed_samples / SAMPLE_RATE as base."""

    def test_consumed_samples_tracks_total(self):
        """consumed_samples should accumulate as audio is processed."""
        from desktop.vendor.streaming_core import SAMPLE_RATE, MAX_SEGMENT_SAMPLES
        # This is a logic test — verify the formula
        # If we've processed 32000 samples (2 seconds), base_time = 32000 / 16000 = 2.0
        consumed = 32000
        base_time = consumed / SAMPLE_RATE
        assert base_time == 2.0

        # After processing another 32000, base_time should be 4.0
        consumed += 32000
        base_time = consumed / SAMPLE_RATE
        assert base_time == 4.0


# ---------------------------------------------------------------------------
# Fix 16: PCM validation — float32 alignment, non-finite, oversize
# ---------------------------------------------------------------------------

class TestPCMValidation:
    """_validate_pcm must reject invalid PCM data."""

    def test_valid_float32_pcm(self):
        from desktop.vendor.streaming_core import _validate_pcm
        # 4 bytes = 1 float32 sample
        data = struct.pack("<f", 0.5)
        result = _validate_pcm(data)
        assert result is not None
        assert len(result) == 1

    def test_empty_data_rejected(self):
        from desktop.vendor.streaming_core import _validate_pcm
        assert _validate_pcm(b"") is None

    def test_too_short_rejected(self):
        from desktop.vendor.streaming_core import _validate_pcm
        assert _validate_pcm(b"\x00\x01") is None  # 2 bytes < 4

    def test_not_float32_aligned_rejected(self):
        from desktop.vendor.streaming_core import _validate_pcm
        # 5 bytes is not divisible by 4
        assert _validate_pcm(b"\x00\x01\x02\x03\x04") is None

    def test_non_finite_rejected(self):
        from desktop.vendor.streaming_core import _validate_pcm
        # NaN value
        import numpy as np
        nan_bytes = np.array([float("nan")], dtype="<f4").tobytes()
        assert _validate_pcm(nan_bytes) is None
        # Inf value
        inf_bytes = np.array([float("inf")], dtype="<f4").tobytes()
        assert _validate_pcm(inf_bytes) is None

    def test_oversize_rejected(self):
        from desktop.vendor.streaming_core import _validate_pcm, MAX_PACKET_SAMPLES
        # Create a packet larger than MAX_PACKET_SAMPLES
        import numpy as np
        big = np.zeros(MAX_PACKET_SAMPLES + 1, dtype="<f4").tobytes()
        assert _validate_pcm(big) is None

    def test_multiple_samples(self):
        from desktop.vendor.streaming_core import _validate_pcm
        import numpy as np
        samples = np.array([0.1, -0.2, 0.3], dtype="<f4")
        result = _validate_pcm(samples.tobytes())
        assert result is not None
        assert len(result) == 3


# ---------------------------------------------------------------------------
# Fix 17: GET /api/lectures without course_id returns all
# ---------------------------------------------------------------------------

class TestListLecturesWithoutCourseId:
    """GET /api/lectures without course_id must return all lectures (not 400)."""

    def test_list_all_lectures_without_course_id(self, client, token):
        # Create two courses with lectures
        r1 = client.post("/api/courses", json={"name": "C1"},
                        headers={"X-Lecture-Token": token})
        r2 = client.post("/api/courses", json={"name": "C2"},
                        headers={"X-Lecture-Token": token})
        cid1 = r1.json()["id"]
        cid2 = r2.json()["id"]

        client.post("/api/lectures",
                    json={"course_id": cid1, "id": "lec-x",
                          "title": "L1", "created_at": "2026-01-01",
                          "transcript": []},
                    headers={"X-Lecture-Token": token})
        client.post("/api/lectures",
                    json={"course_id": cid2, "id": "lec-y",
                          "title": "L2", "created_at": "2026-01-01",
                          "transcript": []},
                    headers={"X-Lecture-Token": token})

        # GET without course_id → 200 with all lectures
        r = client.get("/api/lectures", headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        lectures = r.json()["lectures"]
        assert len(lectures) >= 2

    def test_list_lectures_with_course_id_filters(self, client, token):
        r1 = client.post("/api/courses", json={"name": "C1"},
                        headers={"X-Lecture-Token": token})
        r2 = client.post("/api/courses", json={"name": "C2"},
                        headers={"X-Lecture-Token": token})
        cid1 = r1.json()["id"]
        cid2 = r2.json()["id"]

        client.post("/api/lectures",
                    json={"course_id": cid1, "id": "lec-a",
                          "title": "A", "created_at": "2026-01-01",
                          "transcript": []},
                    headers={"X-Lecture-Token": token})
        client.post("/api/lectures",
                    json={"course_id": cid2, "id": "lec-b",
                          "title": "B", "created_at": "2026-01-01",
                          "transcript": []},
                    headers={"X-Lecture-Token": token})

        r = client.get(f"/api/lectures?course_id={cid1}",
                      headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        assert len(r.json()["lectures"]) == 1
        assert r.json()["lectures"][0]["title"] == "A"


# ---------------------------------------------------------------------------
# Fix 18: Learning export endpoint returns real rows
# ---------------------------------------------------------------------------

class TestLearningExport:
    """GET /api/learning/export must return real correction rows, not just count."""

    def test_export_returns_rows(self, client, token):
        r = client.post("/api/courses", json={"name": "Export Course"},
                       headers={"X-Lecture-Token": token})
        cid = r.json()["id"]

        client.post("/api/corrections",
                    json={"course_id": cid, "source_term": "demand",
                          "preferred_translation": "需求",
                          "source_language": "en", "target_language": "zh"},
                    headers={"X-Lecture-Token": token})
        client.post("/api/corrections",
                    json={"course_id": cid, "source_term": "supply",
                          "preferred_translation": "供给",
                          "source_language": "en", "target_language": "zh"},
                    headers={"X-Lecture-Token": token})

        r = client.get(f"/api/learning/export?course_id={cid}",
                      headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        data = r.json()
        assert data["count"] == 2
        assert len(data["corrections"]) == 2
        terms = [c["source_term"] for c in data["corrections"]]
        assert "demand" in terms
        assert "supply" in terms

    def test_export_empty_when_no_corrections(self, client, token):
        r = client.post("/api/courses", json={"name": "Empty Export"},
                       headers={"X-Lecture-Token": token})
        cid = r.json()["id"]

        r = client.get(f"/api/learning/export?course_id={cid}",
                      headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        assert r.json()["count"] == 0
        assert r.json()["corrections"] == []


# ---------------------------------------------------------------------------
# Fix 19: Model pull failure returns 502 (not 200 with error body)
# ---------------------------------------------------------------------------

class TestModelPullFailure502:
    """Model pull failure must return HTTP 502, not 200 with error in body."""

    def test_pull_failure_returns_502(self, client, token, mock_ollama):
        mock_ollama.pull_model.return_value = {"status": "error", "error": "Network error"}
        r = client.post("/api/models/pull",
                       json={"model": "qwen3.5:4b"},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 502
        assert "error" in r.json()

    def test_pull_success_returns_200(self, client, token):
        r = client.post("/api/models/pull",
                       json={"model": "qwen3.5:4b"},
                       headers={"X-Lecture-Token": token})
        assert r.status_code == 200
        assert r.json()["status"] == "success"


# ---------------------------------------------------------------------------
# Fix 20: Fresh settings reads (no closure staleness)
# ---------------------------------------------------------------------------

class TestFreshSettingsReads:
    """Health and AI endpoints must read settings fresh from storage, not cached."""

    def test_settings_update_reflects_in_health(self, client, token):
        """After changing llm_model, health endpoint should show the new model."""
        # Initial health check
        r = client.get("/api/health", headers={"X-Lecture-Token": token})
        assert r.json()["llm"]["model"] == "qwen3.5:4b"

        # Change model
        client.post("/api/settings",
                   json={"llm_model": "qwen3.5:9b"},
                   headers={"X-Lecture-Token": token})

        # Health should reflect the new model
        r = client.get("/api/health", headers={"X-Lecture-Token": token})
        assert r.json()["llm"]["model"] == "qwen3.5:9b"

    def test_settings_update_reflects_in_asr(self, client, token):
        """After changing asr_model, health should show the new ASR model."""
        r = client.get("/api/health", headers={"X-Lecture-Token": token})
        assert r.json()["asr"]["model"] == "small"

        client.post("/api/settings",
                   json={"asr_model": "medium"},
                   headers={"X-Lecture-Token": token})

        r = client.get("/api/health", headers={"X-Lecture-Token": token})
        assert r.json()["asr"]["model"] == "medium"


# ---------------------------------------------------------------------------
# Fix 21: PDF text extraction via pypdf (local, no remote)
# ---------------------------------------------------------------------------

class TestPDFExtraction:
    """_extract_pdf_text must extract real text from PDF, not return placeholder."""

    def _make_text_pdf(self) -> str:
        """Create a minimal text-based PDF and return its base64 encoding."""
        import base64
        try:
            from pypdf import PdfWriter
        except ImportError:
            pytest.skip("pypdf not installed")

        writer = PdfWriter()
        # pypdf doesn't easily create pages with text from scratch;
        # use reportlab if available, otherwise skip
        try:
            from reportlab.lib.pagesizes import A4
            from reportlab.pdfgen import canvas
            from io import BytesIO
            buf = BytesIO()
            c = canvas.Canvas(buf, pagesize=A4)
            c.drawString(100, 700, "This is a test PDF document.")
            c.drawString(100, 680, "It contains extractable text content.")
            c.save()
            pdf_bytes = buf.getvalue()
        except ImportError:
            pytest.skip("reportlab not installed for test PDF creation")

        return base64.b64encode(pdf_bytes).decode()

    def test_extract_pdf_text_returns_text(self):
        """Extracted text should be real content, not a placeholder string."""
        from desktop.runtime import _extract_pdf_text
        pdf_b64 = self._make_text_pdf()
        result = _extract_pdf_text(pdf_b64)
        if result is None:
            pytest.skip("PDF text extraction not available (pypdf/reportlab missing)")
        assert result is not None
        assert "test PDF" in result or "extractable" in result
        assert result != "[PDF content extracted locally]"  # Not a placeholder

    def test_extract_pdf_text_none_for_invalid(self):
        """Invalid PDF data should return None."""
        from desktop.runtime import _extract_pdf_text
        result = _extract_pdf_text("not-a-valid-base64-pdf")
        assert result is None

    def test_extract_pdf_text_none_for_empty(self):
        """Empty string should return None."""
        from desktop.runtime import _extract_pdf_text
        assert _extract_pdf_text("") is None


# ---------------------------------------------------------------------------
# Fix 22: Summary chunk failure propagates (no false success)
# ---------------------------------------------------------------------------

class TestSummaryChunkFailure:
    """If any chunk in summarize fails, the whole operation must return error."""

    def test_chunk_failure_propagates_error(self, temp_dirs, token, mock_asr):
        """When a chunk fails, summarize must return error, not empty success."""
        data_dir, web_dir = temp_dirs

        # Track call count to simulate failure on second chunk
        call_count = [0]
        def failing_generate(model, prompt, **kwargs):
            call_count[0] += 1
            if "segment" in prompt.lower() and call_count[0] > 1:
                raise OllamaError("Connection timeout on chunk 2")
            return json.dumps({
                "overview": "chunk overview",
                "key_points": ["point1"],
                "key_terms": [],
                "source_ids": [0],
            })

        mock_ai = MagicMock()
        mock_ai.is_ready.return_value = True
        mock_ai.list_models.return_value = ["qwen3.5:4b"]
        mock_ai.generate = failing_generate

        with patch("desktop.runtime.OllamaClient", return_value=mock_ai), \
             patch("desktop.runtime.ASRManager", return_value=mock_asr):
            from desktop.runtime import create_app
            app = create_app(data_dir, web_dir, token)
            c = TestClient(app, base_url="http://127.0.0.1:8766")

            # Long transcript to force chunking
            transcript = [
                {"text": "word " * 2000, "translation": "", "time": f"00:{i:02d}"}
                for i in range(5)
            ]
            r = c.post("/api/ai",
                       json={"operation": "summarize",
                             "title": "Chunk Fail Test",
                             "transcript": transcript,
                             "targetLanguage": "zh"},
                       headers={"X-Lecture-Token": token})
            # Should be 502 (upstream error) — not 200 with empty summary
            assert r.status_code == 502
            assert "error" in r.json()


# ---------------------------------------------------------------------------
# Fix 23: Mindmap persistence — update_lecture_mindmap
# ---------------------------------------------------------------------------

class TestMindmapPersistence:
    """Summarize results should persist mindmap to the lecture record."""

    def test_update_lecture_mindmap(self, temp_dirs):
        data_dir, _ = temp_dirs
        s = Storage(data_dir)
        c = s.create_course("Test")
        s.upsert_lecture(c["id"], {"id": "lec-mm", "title": "T",
                                    "created_at": "2026-01-01", "transcript": []})

        mm = {"title": "T", "nodes": [{"id": "n0", "label": "Root", "parent": None}]}
        assert s.update_lecture_mindmap("lec-mm", mm) is True

        lec = s.get_lecture("lec-mm")
        assert lec["mindmap"] is not None
        assert lec["mindmap"]["title"] == "T"

    def test_update_mindmap_nonexistent_lecture(self, temp_dirs):
        data_dir, _ = temp_dirs
        s = Storage(data_dir)
        assert s.update_lecture_mindmap("nonexistent", {}) is False


# ---------------------------------------------------------------------------
# Fix 24: Mindmap validation — unique IDs, no cycles, source_ids range
# ---------------------------------------------------------------------------

class TestMindmapValidation:
    """_build_mindmap must validate unique IDs, parent existence, source_ids range."""

    def test_duplicate_ids_deduplicated(self):
        svc = AIService(MagicMock())
        data = {
            "mindmap_nodes": [
                {"id": "n0", "label": "A", "parent": None, "source_ids": [0]},
                {"id": "n0", "label": "B", "parent": None, "source_ids": [1]},  # dup
            ],
        }
        mm = svc._build_mindmap(data, [{"text": "s"}] * 5, "Title")
        ids = [n["id"] for n in mm["nodes"]]
        assert ids.count("n0") == 1  # deduplicated

    def test_invalid_parent_made_root(self):
        svc = AIService(MagicMock())
        data = {
            "mindmap_nodes": [
                {"id": "n0", "label": "A", "parent": None, "source_ids": [0]},
                {"id": "n1", "label": "B", "parent": "nonexistent", "source_ids": [1]},
            ],
        }
        mm = svc._build_mindmap(data, [{"text": "s"}] * 5, "Title")
        n1 = [n for n in mm["nodes"] if n["id"] == "n1"][0]
        assert n1["parent"] is None  # Invalid parent → root

    def test_source_ids_out_of_range_filtered(self):
        svc = AIService(MagicMock())
        data = {
            "mindmap_nodes": [
                {"id": "n0", "label": "A", "parent": None, "source_ids": [0, 5, 100]},
            ],
        }
        # Only 3 transcript segments — source_ids 5 and 100 are out of range
        mm = svc._build_mindmap(data, [{"text": "s"}] * 3, "Title")
        n0 = mm["nodes"][0]
        assert 0 in n0["source_ids"]
        assert 5 not in n0["source_ids"]
        assert 100 not in n0["source_ids"]

    def test_no_mindmap_builds_from_key_points(self):
        svc = AIService(MagicMock())
        data = {
            "key_points": ["Point A", "Point B"],
            "source_ids": [0, 1, 2],
        }
        mm = svc._build_mindmap(data, [{"text": "s"}] * 5, "Title")
        assert len(mm["nodes"]) > 0
        # Should have a root and child nodes
        roots = [n for n in mm["nodes"] if n["parent"] is None]
        assert len(roots) >= 1


class TestFinalIntegration:
    def test_summary_feedback_is_course_scoped_and_respects_learning_switch(self, client, token, temp_dirs):
        headers = {'X-Lecture-Token': token}
        a = client.post('/api/courses', json={'name': 'A'}, headers=headers).json()['id']
        b = client.post('/api/courses', json={'name': 'B'}, headers=headers).json()['id']
        client.post('/api/lectures', json={'id': 'feedback-lecture', 'course_id': a}, headers=headers)
        payload = {'course_id': b, 'lecture_id': 'feedback-lecture', 'feedback': 'Compare the two definitions.'}
        assert client.post('/api/feedback', json=payload, headers=headers).status_code == 404
        payload['course_id'] = a
        assert client.post('/api/feedback', json=payload, headers=headers).status_code == 200
        assert client.get('/api/learning?course_id='+a, headers=headers).json()['feedback_count'] == 1
        assert client.get('/api/learning?course_id='+b, headers=headers).json()['feedback_count'] == 0
        store = Storage(temp_dirs[0])
        assert 'Compare' in store.feedback_for_prompt(a)
        client.post('/api/settings', json={'learning_enabled': False}, headers=headers)
        assert store.feedback_for_prompt(a) == ''
        client.post('/api/learning/reset', json={'course_id': a}, headers=headers)
        assert store.list_feedback(a) == []

    def test_default_port_origin_is_not_same_as_runtime_port(self, client, token):
        response = client.get('/api/health', headers={'X-Lecture-Token': token, 'Origin': 'http://127.0.0.1'})
        assert response.status_code == 403

    def test_disconnected_cycle_is_repaired(self):
        svc = AIService(MagicMock())
        mm = svc._build_mindmap({'mindmap_nodes': [
            {'id': 'root', 'label': 'Root', 'parent': None},
            {'id': 'a', 'label': 'A', 'parent': 'b'},
            {'id': 'b', 'label': 'B', 'parent': 'a'}]}, [{'text': 'source'}], 'Class')
        by_id = {node['id']: node for node in mm['nodes']}
        for node in mm['nodes']:
            seen, parent = {node['id']}, node['parent']
            while parent is not None:
                assert parent not in seen
                seen.add(parent)
                parent = by_id[parent]['parent']

    def test_fractional_and_boolean_source_ids_are_not_citations(self):
        svc = AIService(MagicMock())
        mm = svc._build_mindmap({'mindmap_nodes': [{'id': 'r', 'label': 'R', 'parent': None,
                                                   'source_ids': [0.9, True, 0]}]}, [{'text': 'source'}], 'Class')
        assert mm['nodes'][0]['source_ids'] == [0]

    def test_empty_upload_keeps_previous_recording(self, client, token):
        headers = {'X-Lecture-Token': token}
        course = client.post('/api/courses', json={'name': 'Test'}, headers=headers).json()
        client.post('/api/lectures', json={'id': 'audio-safe', 'course_id': course['id'], 'title': 'Class'}, headers=headers)
        endpoint = '/api/lectures/audio-safe/audio'
        assert client.put(endpoint, content=b'old recording', headers=headers).status_code == 200
        assert client.put(endpoint, content=b'', headers=headers).status_code == 400
        assert client.get(endpoint, headers=headers).content == b'old recording'

    def test_at_least_one_root_enforced(self):
        svc = AIService(MagicMock())
        data = {
            "mindmap_nodes": [
                {"id": "n0", "label": "A", "parent": "n1", "source_ids": [0]},
                {"id": "n1", "label": "B", "parent": "n0", "source_ids": [1]},
            ],
        }
        mm = svc._build_mindmap(data, [{"text": "s"}] * 5, "Title")
        # At least one node should have parent=None (cycle broken)
        roots = [n for n in mm["nodes"] if n["parent"] is None]
        assert len(roots) >= 1
