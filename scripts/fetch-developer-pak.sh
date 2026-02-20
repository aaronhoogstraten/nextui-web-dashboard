#!/bin/sh
# Downloads a pinned Developer.pak zip into static/ for bundling.
# Run by CI (deploy.yml) and optionally by developers locally.
# Pin to a known good release to ensure reproducible builds and avoid supply chain risks.
set -e

VERSION="0.9.0"
URL="https://github.com/josegonzalez/minui-developer-pak/releases/download/${VERSION}/Developer.pak.zip"
DEST="static/developer-pak.zip"

echo "Downloading Developer.pak v${VERSION}..."
curl -sL "$URL" -o "$DEST"
echo "Saved to $DEST ($(wc -c < "$DEST") bytes)"
