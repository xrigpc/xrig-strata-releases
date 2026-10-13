#!/usr/bin/env bash
# Downloads every pinned build input into CACHE_DIR and verifies size + SHA-256.
# Usage: fetch-inputs.sh PROFILE CACHE_DIR
# XRIG_THEROCK_CACHE may point at an already verified TheRock tarball (copied, then re-verified).
set -euo pipefail
profile=${1:?usage: fetch-inputs.sh PROFILE CACHE_DIR}
cache=${2:?usage: fetch-inputs.sh PROFILE CACHE_DIR}
here=$(cd "$(dirname "$0")" && pwd)
f() { node "$here/profile.js" "$profile" "$1"; }
f lane_id >/dev/null
mkdir -p "$cache/wheels"

verify() { # FILE SHA SIZE
  [[ "$(stat -c %s "$1")" == "$3" ]] || { echo "size mismatch: $1" >&2; return 1; }
  [[ "$(sha256sum "$1" | awk '{print $1}')" == "$2" ]] || { echo "sha256 mismatch: $1" >&2; return 1; }
}
fetch() { # URL DEST SHA [SIZE]
  local url=$1 dest=$2 sha=$3 size=${4:-}
  if [[ -f "$dest" ]] && { [[ -z "$size" ]] || [[ "$(stat -c %s "$dest")" == "$size" ]]; } && [[ "$(sha256sum "$dest" | awk '{print $1}')" == "$sha" ]]; then
    echo "cached  $(basename "$dest")"; return 0
  fi
  curl --fail --location --retry 3 --continue-at - --output "$dest" "$url" || curl --fail --location --retry 3 --output "$dest" "$url"
  [[ "$(sha256sum "$dest" | awk '{print $1}')" == "$sha" ]] || { echo "sha256 mismatch: $dest" >&2; exit 1; }
  [[ -z "$size" || "$(stat -c %s "$dest")" == "$size" ]] || { echo "size mismatch: $dest" >&2; exit 1; }
  echo "fetched $(basename "$dest")"
}

therock="$cache/therock.tar.gz"
if [[ -n ${XRIG_THEROCK_CACHE:-} && -f ${XRIG_THEROCK_CACHE} && ! -f "$therock" ]]; then
  cp --reflink=auto "$XRIG_THEROCK_CACHE" "$therock"
fi
fetch "$(f therock.url)" "$therock" "$(f therock.sha256)" "$(f therock.size_bytes)"
fetch "$(f source.llama_cpp_zip_url)" "$cache/llama.cpp.zip" "$(f source.llama_cpp_zip_sha256)" "$(f source.llama_cpp_zip_size_bytes)"
fetch "$(f python.url)" "$cache/python.tar.gz" "$(f python.sha256)" "$(f python.size_bytes)"
node -e 'const p=require(require("path").resolve(process.argv[1]));for(const w of p.python.wheels)console.log(w.name,w.url,w.sha256)' "$profile" |
while read -r name url sha; do fetch "$url" "$cache/wheels/$name" "$sha"; done

commit=$(f source.strata_commit)
src="$cache/strata-src"
if [[ ! -d "$src/.git" ]]; then
  git init -q "$src"
  git -C "$src" remote add origin "$(f source.strata_repo)"
fi
git -C "$src" fetch -q --depth=1 origin "$commit"
git -C "$src" checkout -q --detach "$commit"
git -C "$src" reset -q --hard "$commit"
git -C "$src" clean -qfdx
[[ "$(git -C "$src" rev-parse HEAD)" == "$commit" ]] || { echo 'Strata checkout differs from the pin' >&2; exit 1; }
grep -q "VERSION $(f source.strata_version)" "$src/CMakeLists.txt" || { echo 'Strata version differs from the pin' >&2; exit 1; }
echo "Strata $commit verified"
echo 'all pinned inputs verified'
