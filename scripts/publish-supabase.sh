#!/usr/bin/env bash
# Publishes a signed publication tree (build-tree.sh) to the xrig-configs bucket.
# Order is strict, mirroring the llama lane: immutable objects first (stack
# descriptor, config revision), then the signed stacks/v2 index, and the
# catalogues/v3 index LAST: it is the only write that makes Vertex offer the
# configuration, so any earlier failure leaves users unaffected.
# Never touches stacks/v1 or catalogues/v2 (pre-engine Vertex builds read those).
# Usage: publish-supabase.sh TREE_DIR [--dry-run]
# Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, XRIG_ED25519_PUBLIC_KEY_B64
set -euo pipefail
tree=$(realpath "${1:?usage: publish-supabase.sh TREE_DIR [--dry-run]}"); dry=${2:-}
here=$(cd "$(dirname "$0")" && pwd)
[[ -n ${SUPABASE_URL:-} && -n ${XRIG_ED25519_PUBLIC_KEY_B64:-} ]] || { echo 'SUPABASE_URL and XRIG_ED25519_PUBLIC_KEY_B64 are required' >&2; exit 2; }
[[ "$dry" == --dry-run || -n ${SUPABASE_SERVICE_ROLE_KEY:-} ]] || { echo 'SUPABASE_SERVICE_ROLE_KEY is required' >&2; exit 2; }
base="${SUPABASE_URL%/}/storage/v1/object/xrig-configs"; public="${SUPABASE_URL%/}/storage/v1/object/public/xrig-configs"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT

# Every signed document must verify with the production public key before upload.
while IFS= read -r sig; do
  "$here/verify-artifact.sh" "${sig%.sig}" "$sig" >/dev/null
done < <(cd "$tree" && find stacks/v2 configs -name '*.sig' 2>/dev/null | sed "s|^|$tree/|")

put() { # OBJECT FILE MODE(immutable|upsert)
  local object=$1 file=$2 mode=$3 status
  if [[ "$dry" == --dry-run ]]; then echo "would $mode $object ($(stat -c %s "$file") bytes)"; return 0; fi
  local upsert=false; [[ "$mode" == upsert ]] && upsert=true
  status=$(curl -sS -o "$work/response" -w '%{http_code}' -X POST -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "x-upsert: $upsert" -H 'content-type: application/json' --data-binary @"$file" "$base/$object")
  [[ "$status" =~ ^2 ]] && { echo "$mode $object"; return 0; }
  if [[ "$mode" == immutable ]]; then
    # A previous interrupted run may have created it: resume only on identical bytes.
    status=$(curl -sS -o "$work/existing" -w '%{http_code}' "$public/$object")
    [[ "$status" == 200 ]] && cmp -s "$file" "$work/existing" && { echo "exists $object (identical)"; return 0; }
  fi
  echo "write failed or conflicts: $object (HTTP $status)" >&2; cat "$work/response" >&2; return 1
}

cd "$tree"
for f in stacks/v2/*.json configs/*/*.json; do
  [[ -e "$f" && "$f" != stacks/v2/index.json ]] || continue   # a config-only tree has no stacks/v2
  put "$f" "$f" immutable
  put "$f.sig" "$f.sig" immutable
done
if [[ -e stacks/v2/index.json ]]; then
  put stacks/v2/index.json stacks/v2/index.json upsert
  put stacks/v2/index.json.sig stacks/v2/index.json.sig upsert
fi
put catalogues/v3/index.json catalogues/v3/index.json upsert
if [[ -e stacks/v2/index.json ]]; then
  echo 'published stack descriptor, config revision, stacks/v2 index and catalogues/v3 (last)'
else
  echo 'published the config revision and catalogues/v3 (last); its stack was already published'
fi
