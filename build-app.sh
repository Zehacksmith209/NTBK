#!/usr/bin/env bash
# Build ntbk.app for macOS.
#
#   ./build-app.sh
#
# The frontend is rebuilt first on purpose: the bundle carries a COPY of
# frontend/dist, so packaging a stale build ships a stale app, and that
# failure is invisible until someone wonders why a fix did not take.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> building the frontend"
npm --prefix frontend run build

echo "==> packaging"
rm -rf build dist-app
./venv/bin/pyinstaller ntbk.spec --noconfirm --distpath dist-app --workpath build

echo
echo "Built: $(pwd)/dist-app/ntbk.app"
echo "Size:  $(du -sh dist-app/ntbk.app | cut -f1)"
echo
echo "It is NOT code-signed, so the first launch needs:"
echo "  right-click the app > Open > Open"
echo "or:  xattr -dr com.apple.quarantine dist-app/ntbk.app"
