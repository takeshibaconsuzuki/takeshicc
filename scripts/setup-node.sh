#!/usr/bin/env bash
# Workspace-scoped Node install for macOS and Linux.
# Windows uses setup-node.ps1 instead.
set -euo pipefail

NODE_VERSION="v22.11.0"

case "$(uname -s)" in
    Darwin) PLATFORM="darwin" ;;
    Linux)  PLATFORM="linux" ;;
    *) echo "Unsupported OS: $(uname -s) — use setup-node.ps1 on Windows" >&2; exit 1 ;;
esac

case "$(uname -m)" in
    x86_64|amd64)  ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

BASE_NAME="node-${NODE_VERSION}-${PLATFORM}-${ARCH}"
TARBALL="${BASE_NAME}.tar.gz"
URL="https://nodejs.org/dist/${NODE_VERSION}/${TARBALL}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_DIR="${ROOT}/.node.posix"

if [ -x "${NODE_DIR}/bin/node" ]; then
    INSTALLED="$("${NODE_DIR}/bin/node" --version 2>/dev/null || true)"
    if [ "${INSTALLED}" = "${NODE_VERSION}" ]; then
        echo "Node ${NODE_VERSION} already installed at ${NODE_DIR}"
        exit 0
    fi
    echo "Replacing Node ${INSTALLED:-(unknown)} with ${NODE_VERSION} ..."
    rm -rf "${NODE_DIR}"
fi

mkdir -p "${NODE_DIR}"

STAGING="$(mktemp -d)"
trap 'rm -rf "${STAGING}"' EXIT

echo "Downloading ${URL} ..."
curl -fSL "${URL}" -o "${STAGING}/${TARBALL}"

echo "Extracting ..."
tar -xzf "${STAGING}/${TARBALL}" -C "${STAGING}"

# Hoist the tarball's top-level dir contents into .node.posix/ so the layout is
# .node.posix/bin/node (npm/npx stay as relative symlinks into .node.posix/lib).
mv "${STAGING}/${BASE_NAME}"/* "${NODE_DIR}/"

echo "Node ${NODE_VERSION} installed to ${NODE_DIR}"
echo "Use: ./.node.posix/bin/node and ./.node.posix/bin/npm"
