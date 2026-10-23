#!/usr/bin/env bash
# Production release, run on the xrig PC (the only machine holding production
# credentials). Inputs come from the test rig: the packaged runtime directory,
# the data archive directory and the passing qualification evidence.
#   1. fetch and signature-check the live stacks/v2 and catalogues/v3 indexes
#   2. assemble documents with GitHub release asset URLs and Supabase metadata URLs
#   3. build and sign the publication tree (merging the live indexes)
#   4. create the immutable GitHub release (assets, signatures, evidence)
#   5. re-download every release asset and compare digests
#   6. publish metadata to Supabase (catalogue last) -- skipped with --no-publish
# Usage: release-production.sh PROFILE RUNTIME_DIR DATA_DIR QUALIFICATION TAG CONFIG_REVISION [--no-publish]
# Env: XRIG_ED25519_PRIVATE_KEY_B64, XRIG_ED25519_PUBLIC_KEY_B64, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GH_REPO
set -euo pipefail
profile=$(realpath "${1:?usage}"); runtime=$(realpath "${2:?}"); data=$(realpath "${3:?}"); qualification=$(realpath "${4:?}")
tag=${5:?}; revision=${6:?}; publish=${7:-}
here=$(cd "$(dirname "$0")" && pwd)
repo=${GH_REPO:-xrigpc/xrig-strata-releases}
public="${SUPABASE_URL%/}/storage/v1/object/public/xrig-configs"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT

fetch_optional() { # URL OUT -> 0 if fetched, 1 if absent
  local status; status=$(curl -sS -o "$2" -w '%{http_code}' "$1")
  [[ "$status" == 200 ]] && return 0
  [[ "$status" == 400 || "$status" == 404 ]] && { rm -f "$2"; return 1; }
  echo "unexpected HTTP $status for $1" >&2; exit 1
}
if fetch_optional "$public/stacks/v2/index.json" "$work/stacks-v2.json"; then
  curl -fsS "$public/stacks/v2/index.json.sig" -o "$work/stacks-v2.json.sig"
  "$here/verify-artifact.sh" "$work/stacks-v2.json" "$work/stacks-v2.json.sig"
  export EXISTING_STACK_INDEX="$work/stacks-v2.json"
fi
fetch_optional "$public/catalogues/v3/index.json" "$work/catalogue-v3.json" && export EXISTING_CATALOGUE="$work/catalogue-v3.json"

node "$here/assemble-release.js" --profile "$profile" --runtime-dir "$runtime" --data-dir "$data" --qualification "$qualification" \
  --release-tag "$tag" --config-revision "$revision" --asset-base "https://github.com/$repo/releases/download/$tag" \
  --metadata-base "$public" --out "$work/assembled"
"$here/build-tree.sh" "$work/assembled" "$work/tree" "$public"

cp "$qualification" "$work/qualification.json"; "$here/sign-artifact.sh" "$work/qualification.json"
mapfile -t assets < <(find "$work/tree/releases/$tag" -type f | sort)
strata_ref=$(node "$here/profile.js" "$profile" source.strata_ref || true)   # fork sources only
gh release create "$tag" --repo "$repo" --title "RX 7900 XTX 64 GB (Strata, ROCm gfx1100) — $tag" \
  --notes "Strata $(node "$here/profile.js" "$profile" source.strata_version) ($(node "$here/profile.js" "$profile" source.strata_commit)${strata_ref:+, xrigpc/Strata $strata_ref}), TheRock $(node "$here/profile.js" "$profile" therock.version). Qualified on RX 7900 XTX 24 GB + 64 GB RAM." \
  "${assets[@]}" "$runtime/runtime-files.sha256" "$data"/*.files.json "$work/qualification.json" "$work/qualification.json.sig"

mkdir "$work/check"
gh release download "$tag" --repo "$repo" --dir "$work/check" --pattern '*.tar.gz'
for f in "$work/tree/releases/$tag"/*.tar.gz; do
  cmp -s "$f" "$work/check/$(basename "$f")" || { echo "release asset differs after upload: $(basename "$f")" >&2; exit 1; }
done
echo "GitHub release $tag verified"

cp -r "$work/tree" "${XRIG_RELEASE_TREE_OUT:-./publication-$tag}"
if [[ "$publish" == --no-publish ]]; then
  echo "metadata not published; tree kept in ${XRIG_RELEASE_TREE_OUT:-./publication-$tag}"
  exit 0
fi
"$here/publish-supabase.sh" "$work/tree"
