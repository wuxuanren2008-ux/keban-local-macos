"""SQLite storage for local Lecture Companion runtime.

All data is course-scoped.  Audio blobs are stored on disk with a UUID mapping
in the database so that lecture IDs never need to match file paths.
"""

import datetime
import json
import os
import sqlite3
import os
import uuid
from pathlib import Path
from typing import Any


class CourseNotFound(Exception):
    """Raised when a course_id does not exist."""
    pass


class Storage:
    """Thin SQLite wrapper — one connection per call for thread safety."""

    MAX_AUDIO_BYTES = 512 * 1024 * 1024  # 512 MB local limit (no cloud 50MB cap)

    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.audio_dir = self.data_dir / "audio"
        self.audio_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.data_dir / "lecture_companion.db"
        self._init_db()
        self._migrate()

    # ------------------------------------------------------------------
    # Connection helpers
    # ------------------------------------------------------------------
    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _init_db(self):
        with self._conn() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS courses (
                    id         TEXT PRIMARY KEY,
                    name       TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS lectures (
                    id         TEXT PRIMARY KEY,
                    course_id  TEXT NOT NULL,
                    title      TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    language   TEXT,
                    target     TEXT,
                    transcript TEXT,
                    summary    TEXT,
                    mindmap    TEXT,
                    notes      TEXT,
                    duration   TEXT,
                    audio_uuid TEXT,
                    audio_mime TEXT,
                    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS corrections (
                    id                  TEXT PRIMARY KEY,
                    course_id           TEXT NOT NULL,
                    source_term         TEXT NOT NULL,
                    preferred_translation TEXT NOT NULL,
                    source_language     TEXT NOT NULL,
                    target_language     TEXT NOT NULL,
                    created_at           TEXT NOT NULL,
                    UNIQUE(course_id, source_language, target_language, source_term)
                );

                CREATE TABLE IF NOT EXISTS settings (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS course_feedback (
                    id TEXT PRIMARY KEY,
                    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
                    lecture_id TEXT REFERENCES lectures(id) ON DELETE CASCADE,
                    feedback TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )
            defaults = {
                "llm_model": os.environ.get('LECTURE_DEFAULT_LLM', 'qwen3.5:4b') if os.environ.get('LECTURE_DEFAULT_LLM', 'qwen3.5:4b') in {'qwen3.5:2b', 'qwen3.5:4b'} else 'qwen3.5:4b',
                "asr_model": "small",
                "asr_device": "cpu",
                "learning_enabled": "true",
            }
            for k, v in defaults.items():
                conn.execute(
                    "INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)", (k, v)
                )

    def _migrate(self):
        """Add columns that may not exist in older databases."""
        with self._conn() as conn:
            # Get existing columns
            cols = {row[1] for row in conn.execute("PRAGMA table_info(lectures)").fetchall()}
            if "mindmap" not in cols:
                conn.execute("ALTER TABLE lectures ADD COLUMN mindmap TEXT")
            if "audio_mime" not in cols:
                conn.execute("ALTER TABLE lectures ADD COLUMN audio_mime TEXT")

    def _course_exists(self, conn, course_id: str) -> bool:
        r = conn.execute("SELECT 1 FROM courses WHERE id=?", (course_id,)).fetchone()
        return r is not None

    # ------------------------------------------------------------------
    # Courses
    # ------------------------------------------------------------------
    def list_courses(self) -> list[dict]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT id, name FROM courses ORDER BY created_at DESC"
            ).fetchall()
            return [{"id": r["id"], "name": r["name"]} for r in rows]

    def create_course(self, name: str) -> dict:
        cid = str(uuid.uuid4())
        now = datetime.datetime.now().isoformat()
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO courses(id, name, created_at) VALUES(?, ?, ?)",
                (cid, name, now),
            )
        return {"id": cid, "name": name}

    # ------------------------------------------------------------------
    # Lectures
    # ------------------------------------------------------------------
    def list_lectures(self, course_id: str | None = None) -> list[dict]:
        """List lectures. If course_id is None, return all lectures."""
        with self._conn() as conn:
            if course_id:
                rows = conn.execute(
                    "SELECT * FROM lectures WHERE course_id=? ORDER BY created_at DESC",
                    (course_id,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM lectures ORDER BY created_at DESC"
                ).fetchall()
            return [self._lecture_dict(r) for r in rows]

    def get_lecture(self, lecture_id: str) -> dict | None:
        with self._conn() as conn:
            r = conn.execute(
                "SELECT * FROM lectures WHERE id=?", (lecture_id,)
            ).fetchone()
            return self._lecture_dict(r) if r else None

    def upsert_lecture(self, course_id: str, snapshot: dict) -> dict | None:
        """Insert or update a lecture. Raises CourseNotFound if course doesn't exist."""
        lid = snapshot.get("id") or str(uuid.uuid4())
        now = datetime.datetime.now().isoformat()
        title = (snapshot.get("title") or "")[:200]
        created_at = snapshot.get("created_at") or now
        language = snapshot.get("language")
        target = snapshot.get("target")
        transcript = json.dumps(snapshot.get("transcript") or [], ensure_ascii=False)
        summary = snapshot.get("summary")
        summary_json = json.dumps(summary, ensure_ascii=False) if summary else None
        mindmap = snapshot.get("mindmap")
        mindmap_json = json.dumps(mindmap, ensure_ascii=False) if mindmap else None
        notes = snapshot.get("notes")
        duration = snapshot.get("duration")

        with self._conn() as conn:
            if not self._course_exists(conn, course_id):
                raise CourseNotFound(f"Course {course_id} does not exist")

            existing = conn.execute(
                "SELECT id FROM lectures WHERE id=?", (lid,)
            ).fetchone()
            if existing:
                conn.execute(
                    """UPDATE lectures SET
                         course_id=?, title=?, updated_at=?, language=?, target=?,
                         transcript=?, summary=?, mindmap=?, notes=?, duration=?
                       WHERE id=?""",
                    (course_id, title, now, language, target, transcript,
                     summary_json, mindmap_json, notes, duration, lid),
                )
            else:
                conn.execute(
                    """INSERT INTO lectures
                         (id, course_id, title, created_at, updated_at,
                          language, target, transcript, summary, mindmap,
                          notes, duration, audio_uuid, audio_mime)
                       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)""",
                    (lid, course_id, title, created_at, now, language, target,
                     transcript, summary_json, mindmap_json, notes, duration),
                )
        return self.get_lecture(lid)

    def update_lecture_mindmap(self, lecture_id: str, mindmap: dict) -> bool:
        """Update only the mindmap field for a lecture."""
        with self._conn() as conn:
            r = conn.execute("SELECT 1 FROM lectures WHERE id=?", (lecture_id,)).fetchone()
            if not r:
                return False
            conn.execute(
                "UPDATE lectures SET mindmap=? WHERE id=?",
                (json.dumps(mindmap, ensure_ascii=False), lecture_id),
            )
        return True

    def delete_lecture(self, lecture_id: str) -> bool:
        with self._conn() as conn:
            r = conn.execute(
                "SELECT audio_uuid FROM lectures WHERE id=?", (lecture_id,)
            ).fetchone()
            if not r:
                return False
            if r["audio_uuid"]:
                p = self.audio_dir / (r["audio_uuid"] + ".bin")
                if p.exists():
                    p.unlink()
            conn.execute("DELETE FROM lectures WHERE id=?", (lecture_id,))
            return True

    # ------------------------------------------------------------------
    # Audio (UUID-mapped blob storage with atomic writes)
    # ------------------------------------------------------------------
    def put_audio(self, lecture_id: str, data: bytes, mime: str = "audio/webm") -> bool:
        """Store audio atomically: write to temp, then replace. Never overwrites
        old recording on failure."""
        with self._conn() as conn:
            r = conn.execute(
                "SELECT audio_uuid FROM lectures WHERE id=?", (lecture_id,)
            ).fetchone()
            if not r:
                return False
            audio_uuid = r["audio_uuid"] or str(uuid.uuid4())
            # Safe UUID-based path
            audio_path = self.audio_dir / (audio_uuid + ".bin")
            temp_path = self.audio_dir / (audio_uuid + ".tmp")
            try:
                temp_path.write_bytes(data)
                # Atomic replace (old recording only replaced on success)
                temp_path.replace(audio_path)
            except Exception:
                # Cleanup temp on failure — old recording preserved
                if temp_path.exists():
                    temp_path.unlink()
                raise
            conn.execute(
                "UPDATE lectures SET audio_uuid=?, audio_mime=? WHERE id=?",
                (audio_uuid, mime, lecture_id),
            )
        return True

    def commit_audio_file(self, lecture_id: str, temporary: Path, mime: str) -> bool:
        """Commit a streamed recording without copying it into RAM."""
        with self._conn() as conn:
            row = conn.execute('SELECT audio_uuid FROM lectures WHERE id=?', (lecture_id,)).fetchone()
            if row is None:
                return False
            audio_uuid = row['audio_uuid'] or str(uuid.uuid4())
            temporary.replace(self.audio_dir / (audio_uuid + '.bin'))
            conn.execute('UPDATE lectures SET audio_uuid=?, audio_mime=? WHERE id=?', (audio_uuid, mime, lecture_id))
        return True

    def get_audio_path(self, lecture_id: str) -> tuple[Path | None, str | None]:
        """Return (path, mime) for FileResponse streaming — avoids loading entire file."""
        with self._conn() as conn:
            r = conn.execute(
                "SELECT audio_uuid, audio_mime FROM lectures WHERE id=?", (lecture_id,)
            ).fetchone()
            if not r or not r["audio_uuid"]:
                return None, None
            p = self.audio_dir / (r["audio_uuid"] + ".bin")
            if not p.exists():
                return None, None
            return p, r["audio_mime"] or "application/octet-stream"

    def get_audio(self, lecture_id: str) -> bytes | None:
        """Legacy: read entire audio into memory. Prefer get_audio_path for streaming."""
        with self._conn() as conn:
            r = conn.execute(
                "SELECT audio_uuid FROM lectures WHERE id=?", (lecture_id,)
            ).fetchone()
            if not r or not r["audio_uuid"]:
                return None
            p = self.audio_dir / (r["audio_uuid"] + ".bin")
            return p.read_bytes() if p.exists() else None

    # ------------------------------------------------------------------
    # Corrections / Glossary / Learning
    # ------------------------------------------------------------------
    def list_glossary(self, course_id: str) -> list[dict]:
        with self._conn() as conn:
            rows = conn.execute(
                """SELECT source_term, preferred_translation,
                          source_language, target_language
                   FROM corrections WHERE course_id=?""",
                (course_id,),
            ).fetchall()
            return [
                {
                    "source_term": r["source_term"],
                    "preferred_translation": r["preferred_translation"],
                    "source_language": r["source_language"],
                    "target_language": r["target_language"],
                }
                for r in rows
            ]

    def add_correction(
        self, course_id, source_term, preferred_translation,
        source_language, target_language,
    ) -> dict:
        with self._conn() as conn:
            if not self._course_exists(conn, course_id):
                raise CourseNotFound(f"Course {course_id} does not exist")
            cid = str(uuid.uuid4())
            now = datetime.datetime.now().isoformat()
            conn.execute(
                """INSERT INTO corrections
                     (id, course_id, source_term, preferred_translation,
                      source_language, target_language, created_at)
                   VALUES(?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(course_id, source_language, target_language, source_term)
                   DO UPDATE SET preferred_translation=excluded.preferred_translation""",
                (cid, course_id, source_term, preferred_translation,
                 source_language, target_language, now),
            )
        return {"saved": True}

    def reset_learning(self, course_id: str):
        with self._conn() as conn:
            conn.execute(
                "DELETE FROM corrections WHERE course_id=?", (course_id,)
            )
            conn.execute('DELETE FROM course_feedback WHERE course_id=?', (course_id,))

    def add_feedback(self, course_id: str, lecture_id: str, feedback: str):
        lecture = self.get_lecture(lecture_id)
        if not lecture or lecture['course_id'] != course_id:
            raise CourseNotFound(course_id)
        with self._conn() as conn:
            conn.execute('INSERT INTO course_feedback VALUES (?, ?, ?, ?, ?)',
                         (str(uuid.uuid4()), course_id, lecture_id, feedback, datetime.datetime.now().isoformat()))

    def list_feedback(self, course_id: str) -> list[dict]:
        with self._conn() as conn:
            return [dict(row) for row in conn.execute('SELECT lecture_id, feedback, created_at FROM course_feedback WHERE course_id=? ORDER BY created_at DESC', (course_id,)).fetchall()]

    def feedback_for_prompt(self, course_id: str) -> str:
        if self.get_settings().get('learning_enabled', 'true') != 'true':
            return ''
        result = []
        for row in self.list_feedback(course_id):
            if sum(len(value) for value in result) + len(row['feedback']) <= 1000:
                result.append(row['feedback'])
        return '\n'.join(result)

    def delete_correction(self, course_id: str, source_term: str, source_language: str, target_language: str):
        with self._conn() as conn:
            conn.execute('DELETE FROM corrections WHERE course_id=? AND source_term=? AND source_language=? AND target_language=?',
                         (course_id, source_term, source_language, target_language))

    def get_learning(self, course_id: str) -> dict:
        terms = self.list_glossary(course_id)
        settings = self.get_settings()
        enabled = settings.get("learning_enabled", "true") == "true"
        return {"enabled": enabled, "corrections": terms, "terms": terms, 'feedback_count': len(self.list_feedback(course_id))}

    def export_learning(self, course_id: str) -> list[dict]:
        """Export corrections as training pairs for future LoRA — real rows, not just count."""
        return self.list_glossary(course_id)

    def get_corrections_for_prompt(self, course_id: str) -> list[dict]:
        """Return corrections for injection into LLM / Whisper prompts.
        Returns empty list if learning is disabled."""
        settings = self.get_settings()
        if settings.get("learning_enabled", "true") != "true":
            return []
        return self.list_glossary(course_id)

    # ------------------------------------------------------------------
    # Settings
    # ------------------------------------------------------------------
    def get_settings(self) -> dict:
        with self._conn() as conn:
            rows = conn.execute("SELECT key, value FROM settings").fetchall()
            return {r["key"]: r["value"] for r in rows}

    def update_settings(self, settings: dict) -> dict:
        with self._conn() as conn:
            for k, v in settings.items():
                conn.execute(
                    "INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)",
                    (k, str(v).lower() if isinstance(v, bool) else str(v)),
                )
        return self.get_settings()

    # ------------------------------------------------------------------
    def _lecture_dict(self, r: sqlite3.Row) -> dict:
        return {
            "id": r["id"],
            "course_id": r["course_id"],
            "title": r["title"],
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
            "language": r["language"],
            "target": r["target"],
            "transcript": json.loads(r["transcript"]) if r["transcript"] else [],
            "summary": json.loads(r["summary"]) if r["summary"] else None,
            "mindmap": json.loads(r["mindmap"]) if r["mindmap"] else None,
            "notes": r["notes"],
            "duration": r["duration"],
            "hasAudio": bool(r["audio_uuid"]),
            "audio_mime": r["audio_mime"] if "audio_mime" in r.keys() else None,
        }
