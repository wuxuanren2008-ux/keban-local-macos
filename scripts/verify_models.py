"""Real local-model smoke test on synthetic, non-private classroom material."""
import argparse
import json
from pathlib import Path
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from faster_whisper.audio import decode_audio
from desktop.runtime import create_app

parser = argparse.ArgumentParser()
parser.add_argument('wav', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
report = {'material': 'synthetic classroom example; no private recordings', 'models': {}}
with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
    app = create_app(Path(directory), root / 'desktop/web', 'model-verification-token-' + 'a'*40)
    client = TestClient(app, base_url='http://127.0.0.1:8766')
    token = 'model-verification-token-' + 'a'*40
    headers = {'X-Lecture-Token': token}
    course = client.post('/api/courses', json={'name': 'Synthetic economics'}, headers=headers).json()
    audio = decode_audio(str(args.wav), sampling_rate=16000)
    captions = []
    begin = time.perf_counter()
    with client.websocket_connect('ws://127.0.0.1:8766/v1/stream?token='+token, headers={'Origin': 'http://127.0.0.1:8766'}) as socket:
        socket.send_json({'type': 'start', 'sample_rate': 16000, 'language': 'en', 'course_id': course['id']})
        ready = socket.receive_json()
        assert ready['type'] == 'ready', ready
        for offset in range(0, len(audio), 16000):
            socket.send_bytes(audio[offset:offset+16000].astype('<f4').tobytes())
        socket.send_json({'type': 'stop'})
        try:
            while True:
                data = socket.receive_json()
                assert data['type'] != 'error', data
                captions.extend(data.get('stable', []))
        except WebSocketDisconnect:
            pass
    transcript = ' '.join(segment['text'] for segment in captions)
    assert 'opportunity cost' in transcript.lower(), transcript
    report['asr'] = {'model': 'small', 'device': 'cpu', 'text': transcript,
                     'audio_seconds': len(audio)/16000, 'processing_seconds': time.perf_counter()-begin}
    begin = time.perf_counter()
    translation = client.post('/api/ai', json={'operation': 'translate_lecture', 'course_id': course['id'],
                                               'text': transcript, 'source': 'en', 'target': 'zh-CN'}, headers=headers)
    assert translation.status_code == 200, translation.text
    assert '机会成本' in translation.json()['translation'], translation.text
    report['translation'] = {**translation.json(), 'processing_seconds': time.perf_counter()-begin}
    rows = [{'text': segment['text'], 'translation': '', 'time': str(round(segment['start'], 2))} for segment in captions]
    summary = client.post('/api/ai', json={'operation': 'summarize', 'course_id': course['id'],
                                          'title': 'Opportunity cost', 'transcript': rows, 'targetLanguage': 'zh-CN'}, headers=headers)
    assert summary.status_code == 200, summary.text
    assert summary.json()['summary']['key_points']
    assert summary.json()['mindmap']['nodes']
    report['summary'] = summary.json()
    text = ('A pilot study randomized 40 participants to two groups. '
            'The intervention group improved recall by 12 percent after one week. '
            'The study was conducted at a single center and did not assess long-term outcomes. '
            'No p-values were reported.')
    document = client.post('/api/ai', json={'operation': 'translate_document', 'course_id': course['id'],
                                           'title': 'Synthetic pilot study', 'language': 'zh-CN', 'mode': 'paper', 'text': text}, headers=headers)
    assert document.status_code == 200, document.text
    assert document.json()['result']['original'] == text
    report['document_translation'] = document.json()
    analysis = client.post('/api/ai', json={'operation': 'analyze_document', 'course_id': course['id'],
                                           'title': 'Synthetic pilot study', 'language': 'zh-CN', 'mode': 'paper',
                                           'digests': [{'label': 'Section 1', 'digest': document.json()['result']['digest']}]}, headers=headers)
    assert analysis.status_code == 200, analysis.text
    assert analysis.json()['summary']['analysis']
    report['document_analysis'] = analysis.json()
    report['models'] = client.get('/api/health', headers=headers).json()
path = root / 'test-results/model-smoke.json'
path.parent.mkdir(exist_ok=True)
path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print('PASS: real Whisper ASR, Qwen translation, summary/mindmap, document translation and academic analysis')
print(path)
