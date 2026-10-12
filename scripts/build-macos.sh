#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo 'Build on native macOS; Windows executables cannot be repackaged as macOS.' >&2; exit 1; }
case "$(uname -m)" in arm64) arch=arm64;; x86_64) arch=x64;; *) echo 'Unsupported native architecture' >&2; exit 1;; esac
[[ "${LECTURE_BUILD_ARCH:-$arch}" == "$arch" ]] || { echo 'Python runtime and Electron architecture must match.' >&2; exit 1; }
install=true
target=dist:mac
for argument in "$@"; do
  case "$argument" in --skip-install) install=false;; --directory-only) target=pack:mac;; *) echo "Unknown argument: $argument" >&2; exit 1;; esac
done
if [[ ! -x .venv/bin/python ]]; then python3 -m venv .venv; fi
if $install; then
  .venv/bin/python -m pip install -r desktop/requirements-macos.txt
  npm ci
  node node_modules/electron/install.js
fi
.venv/bin/python scripts/prepare_desktop.py
.venv/bin/python -m PyInstaller --noconfirm --onedir --name lecture-runtime --distpath build/runtime --workpath build/pyinstaller --specpath build --paths . --collect-all faster_whisper --collect-all ctranslate2 --collect-all av --collect-all onnxruntime --hidden-import uvicorn.logging --hidden-import uvicorn.loops.auto --hidden-import uvicorn.protocols.http.auto --hidden-import uvicorn.protocols.websockets.auto --hidden-import pypdf desktop/launcher.py
chmod +x build/runtime/lecture-runtime/lecture-runtime
npm run "$target" -- "--$arch" --publish never
echo "Native macOS $arch application built in release/."
