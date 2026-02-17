#!/bin/sh
# Downloads the latest Developer.pak zip into static/ for bundling.
# Run by CI (deploy.yml) and optionally by developers locally.
set -e

URL="https://github.com/josegonzalez/minui-developer-pak/releases/latest/download/Developer.pak.zip"
DEST="static/developer-pak.zip"

echo "Downloading latest Developer.pak..."
curl -sL "$URL" -o "$DEST"
echo "Saved to $DEST ($(wc -c < "$DEST") bytes)"
