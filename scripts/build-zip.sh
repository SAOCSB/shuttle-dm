#!/usr/bin/env bash
# Packages extension/ as dist/shuttle-dm-<version>.zip for the Chrome Web Store and Edge Add-ons
# (manifest.json at the root of the zip).
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' extension/manifest.json | head -n 1)
mkdir -p dist
out="dist/shuttle-dm-$version.zip"
rm -f "$out"
(cd extension && zip -r -X -q "../$out" . -x '.*' -x '*/.*')
echo "$out ($(du -h "$out" | cut -f1))"
