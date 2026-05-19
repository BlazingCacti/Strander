#!/usr/bin/env bash
# Produce a production .vsix for marketplace publishing.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Cleaning previous artifacts"
rm -f ./*.vsix
rm -rf out media/webview.js

echo "==> Installing dependencies (clean)"
npm ci

echo "==> Building extension + webview"
npm run build

echo "==> Packaging .vsix"
npx --yes @vscode/vsce package --no-yarn

VSIX="$(ls -1 ./*.vsix | head -n 1)"
echo ""
echo "==> Done. Produced: ${VSIX}"
echo "    Publish with: npx @vscode/vsce publish"
echo "    (or: npx @vscode/vsce publish -p <PAT>)"
