#!/usr/bin/env bash
# Test the device update notification bar end-to-end.
#
# Temporarily patches device-update.svelte.ts to:
#   - Auto-trigger the GitHub release check on page load
#   - Bypass the isConnected() check
#   - Hardcode an old device version so it always looks outdated
#
# Starts the dev server — the blue "update available" bar should appear.
# Press Ctrl+C to stop and revert all changes.

set -euo pipefail

STORE="src/lib/stores/device-update.svelte.ts"

echo "==> Patching $STORE for testing..."

# 1. Auto-trigger checkForDeviceUpdate() on module load
sed -i '/^let fetchStatus/a\checkForDeviceUpdate();' "$STORE"

# 2. Hardcode an old device version instead of reading from the device
sed -i "s|getNextUIVersion()\.split.*|'NextUI-20240101-0';|" "$STORE"

# 3. Bypass isConnected() check
sed -i 's|isConnected() &&|true \&\&|' "$STORE"

echo "==> Starting dev server..."
echo ""
echo "============================================"
echo "  Open http://localhost:5173 in your browser."
echo "  The blue 'update available' bar should"
echo "  appear at the top of the page."
echo ""
echo "  Press Ctrl+C when done."
echo "============================================"
echo ""

npm run dev
