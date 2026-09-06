#!/usr/bin/env bash
# Copy the installers from a GitHub release into site/dl and deploy the site to Cloudflare Pages.
#   scripts/publish-site.sh v0.1.2
set -euo pipefail
tag="${1:?usage: publish-site.sh vX.Y.Z}"
ver="${tag#v}"
cd "$(dirname "$0")/.."
mkdir -p site/dl
base="https://github.com/leecyrille/intertitle/releases/download/$tag"
for f in "Intertitle_${ver}_x64-setup.exe" "Intertitle_${ver}_universal.dmg" "Intertitle_${ver}_amd64.deb" intertitle-cli-windows.exe intertitle-cli-macos intertitle-cli-linux; do
  echo "fetching $f"
  curl -sSL --fail -o "site/dl/$f" "$base/$f"
done
# stable names so the page never needs editing for a new version
cp "site/dl/Intertitle_${ver}_x64-setup.exe" site/dl/Intertitle-Setup-Windows.exe
cp "site/dl/Intertitle_${ver}_universal.dmg" site/dl/Intertitle-macOS.dmg
cp "site/dl/Intertitle_${ver}_amd64.deb" site/dl/Intertitle-Linux.deb
rm -f "site/dl/Intertitle_${ver}_"*
echo "$ver" > site/dl/VERSION
ls -la site/dl
npx --yes wrangler@latest pages deploy site --project-name intertitle --branch main --commit-dirty=true
