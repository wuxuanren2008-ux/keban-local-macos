"""Run on macOS natively; OS-specific assertions skip on non-Darwin hosts."""
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from desktop.storage import Storage

def test_low_memory_default_preserves_existing_user_setting(monkeypatch):
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
        monkeypatch.setenv('LECTURE_DEFAULT_LLM', 'qwen3.5:2b')
        store = Storage(Path(directory))
        assert store.get_settings()['llm_model'] == 'qwen3.5:2b'
        store.update_settings({'llm_model': 'qwen3.5:4b'})
        assert Storage(Path(directory)).get_settings()['llm_model'] == 'qwen3.5:4b'

@pytest.mark.skipif(sys.platform != 'darwin', reason='Requires a native macOS host')
def test_native_macos_rejects_cuda_configuration():
    from desktop.runtime import create_app
    with tempfile.TemporaryDirectory() as directory:
        with patch('desktop.runtime.OllamaClient', return_value=MagicMock()), patch('desktop.runtime.ASRManager', return_value=MagicMock()):
            app = create_app(Path(directory), Path(directory), 'a'*64)
        client = TestClient(app, base_url='http://127.0.0.1:8766')
        response = client.post('/api/settings', json={'asr_device': 'cuda'}, headers={'X-Lecture-Token': 'a'*64})
        assert response.status_code == 400
