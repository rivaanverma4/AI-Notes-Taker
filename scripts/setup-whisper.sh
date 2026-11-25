#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="$ROOT/.tools"
MODELS="$ROOT/models"
WHISPER_VERSION="v1.9.5"
WHISPER_DIR="$TOOLS/whisper.cpp"
MODEL_NAME="ggml-large-v3-turbo-q8_0.bin"
MODEL_PATH="$MODELS/$MODEL_NAME"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_NAME"

mkdir -p "$TOOLS" "$MODELS"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required to install a project-local CMake." >&2
  exit 1
fi

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Xcode Command Line Tools are required. Run: xcode-select --install" >&2
  exit 1
fi

if [ ! -x "$TOOLS/venv/bin/cmake" ]; then
  echo "Installing a project-local CMake (no Homebrew required)..."
  python3 -m venv "$TOOLS/venv"
  "$TOOLS/venv/bin/python" -m pip install --quiet --upgrade pip
  "$TOOLS/venv/bin/python" -m pip install --quiet "cmake==3.31.10"
fi

CMAKE="$TOOLS/venv/bin/cmake"

if [ ! -d "$WHISPER_DIR/.git" ]; then
  echo "Fetching whisper.cpp $WHISPER_VERSION..."
  git clone --depth 1 --branch "$WHISPER_VERSION" https://github.com/ggml-org/whisper.cpp.git "$WHISPER_DIR"
fi

if [ ! -x "$WHISPER_DIR/build/bin/whisper-server" ]; then
  echo "Building whisper.cpp with Metal acceleration..."
  "$CMAKE" -S "$WHISPER_DIR" -B "$WHISPER_DIR/build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DGGML_METAL=ON \
    -DWHISPER_BUILD_TESTS=OFF \
    -DWHISPER_BUILD_SERVER=ON
  "$CMAKE" --build "$WHISPER_DIR/build" --config Release --target whisper-server -j "$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"
fi

if [ ! -f "$MODEL_PATH" ]; then
  echo "Downloading $MODEL_NAME (~834 MB)..."
  curl -L --fail --retry 3 --retry-delay 2 -o "$MODEL_PATH.part" "$MODEL_URL"
  mv "$MODEL_PATH.part" "$MODEL_PATH"
fi

MODEL_BYTES="$(stat -f%z "$MODEL_PATH")"
if [ "$MODEL_BYTES" -lt 800000000 ]; then
  echo "The Whisper model download appears incomplete ($MODEL_BYTES bytes)." >&2
  exit 1
fi

echo ""
echo "Local speech-to-text is ready:"
echo "  server: $WHISPER_DIR/build/bin/whisper-server"
echo "  model:  $MODEL_PATH"
echo ""
echo "Next: make sure Ollama is running, then start the app with: npm run dev"
