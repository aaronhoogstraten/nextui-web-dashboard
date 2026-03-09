#!/usr/bin/env bash
# Test the version update notification end-to-end.
#
# 1. Temporarily shortens the poll interval to 10 seconds
# 2. Builds with APP_VERSION=v1.0.0 and matching version.json
# 3. Starts a simple HTTP server (no caching)
# 4. Press Enter → modifies version.json to v2.0.0 (no restart needed)
# 5. Within ~10 seconds the sidebar shows the update notification
#
# Press Ctrl+C to stop and clean up.

set -euo pipefail

STORE="src/lib/stores/version.svelte.ts"
PORT=4173

cleanup() {
  echo ""
  echo "Restoring poll interval and version.json..."
  sed -i 's|const POLL_INTERVAL = 10 \* 1000; // 10 seconds (test override)|const POLL_INTERVAL = 60 \* 60 \* 1000; // 60 minutes|' "$STORE"
  echo '{"version":"dev"}' > static/version.json
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  echo "Done."
}
trap cleanup EXIT

echo "==> Shortening poll interval to 10s for testing..."
sed -i 's|const POLL_INTERVAL = 60 \* 60 \* 1000; // 60 minutes|const POLL_INTERVAL = 10 \* 1000; // 10 seconds (test override)|' "$STORE"

echo "==> Writing matching version.json before build..."
echo '{"version":"v1.0.0"}' > static/version.json

echo "==> Building with APP_VERSION=v1.0.0..."
CUSTOM_DOMAIN=true APP_VERSION=v1.0.0 npm run build --silent

echo "==> Starting HTTP server (no caching)..."
npx -y http-server build -p $PORT -c-1 --silent &
SERVER_PID=$!
sleep 2

echo ""
echo "============================================"
echo "  Open http://localhost:$PORT in your browser."
echo "  You should see 'v1.0.0' in the sidebar."
echo ""
echo "  Press Enter to simulate a new deployment."
echo "============================================"

read -r

echo "==> Changing build/version.json to v2.0.0..."
echo '{"version":"v2.0.0"}' > build/version.json

echo ""
echo "============================================"
echo "  Within ~10 seconds the sidebar should"
echo "  change to show the update notification."
echo "  (No refresh needed!)"
echo ""
echo "  Press Ctrl+C when done."
echo "============================================"

wait "$SERVER_PID"
