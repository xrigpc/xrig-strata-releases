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
repo=$(f source.strata_repo)
src="$cache/strata-src"
[[ -d "$src/.git" ]] || git init -q "$src"
# Every run: a cache made for another profile may point at the other Strata repository.
git -C "$src" remote add origin "$repo" 2>/dev/null || git -C "$src" remote set-url origin "$repo"
git -C "$src" fetch -q --depth=1 origin "$commit"
# --force: a cache last used for a patched profile has those patches applied and staged.
git -C "$src" checkout -q --force --detach "$commit"
git -C "$src" reset -q --hard "$commit"
git -C "$src" clean -qfdx
[[ "$(git -C "$src" rev-parse HEAD)" == "$commit" ]] || { echo 'Strata checkout differs from the pin' >&2; exit 1; }
grep -q "VERSION $(f source.strata_version)" "$src/CMakeLists.txt" || { echo 'Strata version differs from the pin' >&2; exit 1; }
echo "Strata $commit verified"
if ref=$(f source.strata_ref); then
  # Fork source: the commit is the pin; its tree and the tag must agree with the profile.
  tree=$(git -C "$src" rev-parse 'HEAD^{tree}')
  [[ "$tree" == "$(f source.expected_tree)" ]] || { echo "Strata tree $tree differs from source.expected_tree" >&2; exit 1; }
  echo "Strata tree $tree verified"
  # The fetch above already needs GitHub, so the tag is always checked.
  tags=$(git ls-remote "$repo" "refs/tags/$ref" "refs/tags/$ref^{}")
  tagged=$(awk -v r="refs/tags/$ref" '$2 == r "^{}" { p = $1 } $2 == r { l = $1 } END { print (p != "" ? p : l) }' <<< "$tags")
  [[ "$tagged" == "$commit" ]] || { echo "tag $ref is '${tagged:-missing}' on $repo, not the pinned $commit" >&2; exit 1; }
  echo "tag $ref verified"
fi
patches=$(node -e 'const p=require(require("path").resolve(process.argv[1]));for(const x of (p.source.patches||[]))console.log(x.file,x.sha256)' "$profile")
if [[ -n "$patches" ]]; then
  while read -r pf psha; do
    pp="$here/../$pf"
    [[ "$(sha256sum "$pp" | awk '{print $1}')" == "$psha" ]] || { echo "patch sha256 mismatch: $pf" >&2; exit 1; }
    git -C "$src" apply --whitespace=nowarn "$pp"
    echo "applied $pf"
  done <<< "$patches"
  git -C "$src" add -A
  tree=$(git -C "$src" write-tree)
  [[ "$tree" == "$(f source.expected_tree)" ]] || { echo "patched tree $tree differs from source.expected_tree" >&2; exit 1; }
  echo "patched tree $tree verified"
fi
echo 'all pinned inputs verified'
