"""Export a clean publication tree; never include runtime data or old Git history."""
from pathlib import Path
import re
import shutil

root = Path(__file__).resolve().parents[1]
output = root / 'publish-source'
output.mkdir(exist_ok=True)

files = ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', '.gitignore']
for name in files:
    shutil.copy2(root / name, output / name)
for directory in ['desktop/frontend', 'desktop/vendor', 'tests', '.github']:
    for source in (root / directory).rglob('*'):
        if source.is_file() and '__pycache__' not in source.parts and source.suffix not in {'.pyc', '.pyo'}:
            target = output / source.relative_to(root)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
for source in (root / 'desktop').iterdir():
    if source.is_file() and source.suffix in {'.py', '.cjs', '.txt', '.ico', '.icns', '.plist'}:
        target = output / source.relative_to(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
for name in ['build-desktop.ps1', 'build-macos.sh', 'prepare_desktop.py', 'desktop-smoke.cjs', 'verify_models.py', 'generate_icon.py', 'prepare_public_source.py', 'fix-nsis.cjs', 'prepare-native-ollama.cjs', 'prepare-ci-audio.py']:
    target = output / 'scripts' / name
    target.parent.mkdir(exist_ok=True)
    shutil.copy2(root / 'scripts' / name, target)
for name in ['local-desktop-guide.md', 'local-model-comparison.md', 'macos-compatibility.md', 'macos-guide.md', 'validation-evidence.md']:
    target = output / 'docs' / name
    target.parent.mkdir(exist_ok=True)
    shutil.copy2(root / 'docs' / name, target)
for source in (root / 'dist').rglob('*'):
    if not source.is_file() or source.name.startswith('admin') or source.name == '_headers':
        continue
    target = output / source.relative_to(root)
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.name == 'index.html':
        html = source.read_text(encoding='utf-8')
        html = re.sub(r'window.LECTURE_COMPANION_CONFIG=\{.*?\};', 'window.LECTURE_COMPANION_CONFIG={};', html)
        target.write_text(html, encoding='utf-8')
    else:
        shutil.copy2(source, target)
print(output)
