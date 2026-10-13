"""Local system subtitles accept Chinese explicitly, without forcing English ASR."""
import asyncio
from unittest.mock import MagicMock
from desktop.vendor.streaming_core import StreamingSession

def test_chinese_start_routes_to_whisper_and_keeps_course_scope():
    asr, storage = MagicMock(), MagicMock()
    asr.get_engine.return_value.ready = True
    asr.build_initial_prompt.return_value = "机会成本"
    storage.get_corrections_for_prompt.return_value = []
    session = StreamingSession(MagicMock(), asr, storage)
    result = asyncio.run(session.handle_start({"sample_rate":16000, "language":"zh", "course_id":"course-zh"}))
    assert result == {"type":"ready"}
    assert session.language == "zh"
    storage.get_corrections_for_prompt.assert_called_once_with("course-zh")

def test_unknown_language_is_rejected_before_engine_load():
    asr = MagicMock()
    session = StreamingSession(MagicMock(), asr, MagicMock())
    result = asyncio.run(session.handle_start({"sample_rate":16000, "language":"invalid"}))
    assert result["type"] == "error"
    asr.get_engine.assert_not_called()
