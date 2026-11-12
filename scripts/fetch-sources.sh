#!/usr/bin/env bash
# Downloads the metadata the index is built from: each GLB pack's metadata.jsonl and the asset-index table.
set -euo pipefail
cd "$(dirname "$0")/.."
base="https://huggingface.co/datasets/codepawl"
packs=$(node --input-type=module -e "import { PACKS } from './scripts/sources.mjs'; console.log(PACKS.map((pack) => pack.repo).join(' '))")
for pack in $packs; do
  mkdir -p "cache/packs/$pack"
  curl -sfL -o "cache/packs/$pack/metadata.jsonl" "$base/$pack/resolve/main/metadata.jsonl"
done
curl -sfL -o "cache/packs/simready-glb/manifest.jsonl" "$base/simready-glb/resolve/main/manifest.jsonl"
mkdir -p cache/asset-index
curl -sfL -o cache/asset-index/metadata.jsonl "$base/asset-index/resolve/main/metadata.jsonl"
echo "fetched $(echo $packs | wc -w) packs and the asset index"
