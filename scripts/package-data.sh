#!/usr/bin/env bash
# Packs a prepared Strata data directory (the IQ2_XS pack, the MTP draft) into a deterministic
# tar.gz whose entries are relative to the directory, plus a per-file manifest. Vertex extracts
# it into models/<directory> and verifies every listed file.
# Usage: package-data.sh SOURCE_DIR NAME VERSION OUT_DIR [EXPECTED_SHA256SUMS]
#   EXPECTED_SHA256SUMS: optional `sha256sum` output whose entries for SOURCE_DIR must all match.
set -euo pipefail
src=$(realpath "${1:?usage: package-data.sh SOURCE_DIR NAME VERSION OUT_DIR [EXPECTED_SHA256SUMS]}")
name=${2:?}; version=${3:?}; out=${4:?}; expected=${5:-}
[[ "$name" =~ ^[a-z0-9][a-z0-9._-]+$ && "$version" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$ ]] || { echo 'invalid name or version' >&2; exit 2; }
[[ -z "$(find "$src" -type l)" ]] || { echo 'data directories must not contain symlinks' >&2; exit 1; }
mkdir -p "$out"
archive="$out/xrig-strata-data-${name}-${version}.tar.gz"
[[ ! -e "$archive" ]] || { echo 'archive exists' >&2; exit 2; }
manifest="$out/xrig-strata-data-${name}-${version}.files.json"
(cd "$src" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sed 's| \./| |') > "$out/.$name.sha256"
if [[ -n "$expected" ]]; then
  while read -r sha rel; do
    want=$(awk -v p="$src/$rel" '$2==p {print $1}' "$expected")
    [[ -n "$want" ]] || { echo "no frozen hash for $rel" >&2; exit 1; }
    [[ "$want" == "$sha" ]] || { echo "frozen hash mismatch for $rel" >&2; exit 1; }
  done < <(grep -v '/tokenizer/' "$out/.$name.sha256")
fi
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$src" -cf - . | gzip -n -1 > "$archive"
size=$(stat -c %s "$archive")
(( size < 2147483648 )) || { echo "$name archive exceeds the 2 GiB GitHub asset limit; split it" >&2; exit 1; }
sha=$(sha256sum "$archive" | awk '{print $1}')
python3 - "$out/.$name.sha256" "$src" "$manifest" "$sha" "$size" "$(basename "$archive")" <<'PY'
import json, os, sys
sums, src, out, sha, size, asset = sys.argv[1:7]
files = []
for line in open(sums):
    digest, rel = line.rstrip("\n").split(" ", 1)
    rel = rel.strip()
    files.append({"path": rel, "sha256": digest, "size_bytes": os.path.getsize(os.path.join(src, rel))})
json.dump({"asset_name": asset, "sha256": sha, "size_bytes": int(size), "format": "tar.gz", "files": files},
          open(out, "w"), indent=1)
PY
rm -f "$out/.$name.sha256"
echo "packaged $(basename "$archive"): $size bytes, sha256 $sha"
