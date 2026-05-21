#!/usr/bin/env bash
# Local dev: build, package, and install into VS Code Insiders.
set -euo pipefail
cd "$(dirname "$0")/.."

EXT_ID="strander"
EXT_VERSION="$(node -p "require('./package.json').version")"
EXT_DIR="${HOME}/.vscode-server-insiders/extensions/${EXT_ID}-${EXT_VERSION}"

echo "==> Building extension + webview"
npm run build

echo "==> Packaging .vsix"
rm -f ./*.vsix
PRE_RELEASE_FLAG=""
for arg in "$@"; do
  [ "$arg" = "--pre-release" ] && PRE_RELEASE_FLAG="--pre-release"
done
npx --yes @vscode/vsce package \
  --no-dependencies \
  --no-yarn \
  --skip-license \
  --allow-missing-repository \
  $PRE_RELEASE_FLAG

VSIX="$(ls -1 ./*.vsix | head -n 1)"
VSIX_ABS="$(cd "$(dirname "${VSIX}")" && pwd)/$(basename "${VSIX}")"

echo "==> Installing to ${EXT_DIR}"
rm -rf "${EXT_DIR}" /tmp/strander-install
mkdir -p /tmp/strander-install
( cd /tmp/strander-install && unzip -q "${VSIX_ABS}" )
mkdir -p "${EXT_DIR}"
cp -r /tmp/strander-install/extension/. "${EXT_DIR}/"
rm -rf /tmp/strander-install

echo ""
echo "==> Installed Strander ${EXT_VERSION} into VS Code Insiders."
echo "    Run 'Developer: Reload Window' in VS Code Insiders to activate."
