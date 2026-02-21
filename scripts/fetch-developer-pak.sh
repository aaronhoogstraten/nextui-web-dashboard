#!/bin/sh
# Downloads a pinned Developer.pak zip and pak.json into static/ for bundling.
# Run by CI (deploy.yml) and optionally by developers locally.
# Pin to a known good release to ensure reproducible builds and avoid supply chain risks.
set -e

VERSION="0.9.0"
ZIP_URL="https://github.com/josegonzalez/minui-developer-pak/releases/download/${VERSION}/Developer.pak.zip"
PAKJSON_URL="https://raw.githubusercontent.com/josegonzalez/minui-developer-pak/refs/tags/${VERSION}/pak.json"

echo "Downloading Developer.pak v${VERSION}..."
curl -sL "$ZIP_URL" -o "static/developer-pak.zip"
echo "Saved static/developer-pak.zip ($(wc -c < "static/developer-pak.zip") bytes)"

echo "Downloading pak.json v${VERSION}..."
curl -sL "$PAKJSON_URL" -o "static/developer-pak.json"
echo "Saved static/developer-pak.json ($(wc -c < "static/developer-pak.json") bytes)"
