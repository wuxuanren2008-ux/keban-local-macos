"""Build the desktop web assets from the unchanged website UI."""
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'desktop' / 'web'
OUT.mkdir(parents=True, exist_ok=True)
for path in (ROOT / 'dist').iterdir():
    if path.is_file() and path.suffix in {'.js', '.css', '.html'} and path.name not in {'admin.js', 'admin.css', 'admin.html', 'gemini-client.js'}:
        shutil.copy2(path, OUT / path.name)
shutil.copytree(ROOT / 'dist' / 'vendor', OUT / 'vendor', dirs_exist_ok=True)
for path in (ROOT / 'desktop' / 'frontend').iterdir():
    shutil.copy2(path, OUT / path.name)
html = (OUT / 'index.html').read_text(encoding='utf-8')
html = re.sub(r'<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>', '', html)
html = re.sub(r'window.LECTURE_COMPANION_CONFIG=\{.*?\};', 'window.LECTURE_COMPANION_CONFIG={local:true};', html)
html = html.replace('cloudAuthed=false', 'cloudAuthed=true').replace('accountUserId=null,qualityRun', "accountUserId='desktop',qualityRun")
html = html.replace('GeminiRecognition', 'LocalRecognition')
html = html.replace('<script src="gemini-client.js"></script>', '<script src="local-recognition.js"></script>')
html = html.replace('</head>', '<link rel="stylesheet" href="local.css"></head>')
html = html.replace('</body>', '<script src="local.js"></script><script src="subtitle-payload.js"></script><script src="system-subtitles.js"></script></body>')
# Cloud initialization and unsolicited cloud consent dialogs never run locally.
html = re.sub(r'const siteConfig=window\.LECTURE_COMPANION_CONFIG.*?\n', 'const siteConfig=window.LECTURE_COMPANION_CONFIG;\n', html)
html = html.replace("if(localStorage.getItem('lc_quality_notice_seen')!==QUALITY_VERSION)", 'if(false)')
html = html.replace('我同意将本堂音频片段、文字和个人术语发送给 Google Gemini，进行转录与翻译。', '使用本机 Whisper 识别与本机 LLM 翻译。')
html = html.replace('需登录。使用免费 API 时，Google 可能将内容用于改进产品；不要录制敏感内容。此选项与课伴的自愿改进数据共享分开。', '录音、原文和译文保存在这台电脑。首次下载模型需要网络。')
html = html.replace('登录可同步笔记；登录并同意音频处理后，可使用 Gemini 转录和翻译。', '本机 Whisper 转写与 LLM 翻译；课堂按课程保存。')
html = html.replace('我同意将本堂文字发送给 Gemini 生成总结。', '使用本机模型整理本堂课堂内容。')
html = html.replace('需要登录，可能受 AI 免费额度限制。', '根据本堂原文提炼重点；可回到对应字幕核查。')
html = html.replace('<option value="ms-MY">', '<option value="zh-CN">中文 · Chinese（中译英）</option><option value="ms-MY">')
html = html.replace("lang:code.startsWith('ms')?", "lang:code.startsWith('zh')?'中文':code.startsWith('ms')?")
html = html.replace('口音和网络会影响结果。', '口音、设备和模型会影响结果。')
html = html.replace('自动保存到本机；点击云端保存可同步。', '自动保存到本机课程资料库。')
html = html.replace('录音保存在本机；改进计划单独征求同意。', '录音、译文、总结与思维导图按课程归档。')
html = html.replace('data-study="notes">笔记</button>', 'data-study="notes">笔记</button><button role="tab" aria-selected="false" data-study="mindmap">导图</button>')
html = html.replace('<div class="study-pane hidden" id="notesPane"', '<div class="study-pane hidden" id="mindmapPane" role="tabpanel"><div id="mindmapContent"><p class="sub">生成课堂总结后，在这里查看知识结构与来源。</p></div><button class="btn" id="exportMindmap">导出思维导图</button></div><div class="study-pane hidden" id="notesPane"')
html = html.replace('<label for="title">课程名称</label>', '<label for="title">本节课堂名称</label>')
html = html.replace('<div class="session-bar">', '<div class="course-toolbar"><label for="courseSelect">所属课程</label><select id="courseSelect"></select><button class="btn" id="addCourse">＋ 新课程</button><span class="sub" id="learningStatus"></span></div><div class="session-bar">')
html = html.replace('本机课堂按当前登录账户保存，访客课堂单独存储。本机录音不随个人笔记同步到其他设备。导入备份不会自动上传。', '按所选课程查看课堂；录音与文字保存在本机资料库。导出备份可迁移到其他电脑。')
(OUT / 'index.html').write_text(html, encoding='utf-8')

# Feed an already-authorized system audio stream through the unchanged classroom
# session/recording archive. A click Event is never accepted as a MediaStream.
studio = (OUT / 'studio.js').read_text(encoding='utf-8')
before = 'start=async function(){if(active||studioStarting)return;'
after = 'start=async function(inputStream){if(active||studioStarting)return;'
assert before in studio, 'Classroom start adapter changed'
studio = studio.replace(before, after, 1)
before = 'preparedStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}})'
after = "preparedStream=(inputStream instanceof MediaStream)?inputStream:await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}})"
assert before in studio, 'Classroom microphone adapter changed'
studio = studio.replace(before, after, 1)
(OUT / 'studio.js').write_text(studio, encoding='utf-8')

docs = (OUT / 'documents.js').read_text(encoding='utf-8')
start = docs.index('  async function invoke(')
end = docs.index('  async function run()', start)
docs = docs[:start] + '  async function invoke(body,signal){return window.localAI(body,signal)}\n' + docs[end:]
docs = docs.replace('Gemini', '本机模型').replace('需要登录课伴；使用网站已配置的 本机模型 服务。', '请先在本机模型设置中完成配置。').replace('已登录 ·', '本机处理 ·')
docs = docs.replace('原文件先在本机准备，点击开始后才发送给 本机模型。', '原文件在本机提取与分析。')
docs = docs.replace("let owner=accountUserId||'guest'", "let owner='desktop:'+localStorage.getItem('lc_desktop_course')")
docs = docs.replace("const next=accountUserId||'guest'", "const next='desktop:'+window.localCourseId")
docs += "\nwindow.addEventListener('lecture-course-changed',()=>window.studioAccountChanged?.());\n"
(OUT / 'documents.js').write_text(docs, encoding='utf-8')
core = (OUT / 'documents-core.js').read_text(encoding='utf-8').replace('CHUNK=6000', 'CHUNK=3000')
(OUT / 'documents-core.js').write_text(core, encoding='utf-8')
print(OUT)
