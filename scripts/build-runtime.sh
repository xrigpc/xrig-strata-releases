#!/usr/bin/env bash
# Builds the portable Strata engine + vision encoder in the digest-pinned container.
# Usage: build-runtime.sh PROFILE CACHE_DIR OUT_DIR   (run fetch-inputs.sh first)
set -euo pipefail
profile=${1:?usage: build-runtime.sh PROFILE CACHE_DIR OUT_DIR}
cache=${2:?usage: build-runtime.sh PROFILE CACHE_DIR OUT_DIR}
out=${3:?usage: build-runtime.sh PROFILE CACHE_DIR OUT_DIR}
here=$(cd "$(dirname "$0")" && pwd)
[[ ! -e "$out" ]] || { echo 'output already exists' >&2; exit 2; }
image=$(node "$here/profile.js" "$profile" build_image)
for f in therock.tar.gz llama.cpp.zip strata-src; do [[ -e "$cache/$f" ]] || { echo "missing input $f: run fetch-inputs.sh" >&2; exit 1; }; done
mkdir -p "$out"
podman run --rm --pull=missing \
  -e XRIG_BUILD_JOBS="${XRIG_BUILD_JOBS:-}" \
  -v "$(realpath "$cache")":/in:ro,Z \
  -v "$(realpath "$profile")":/profile.json:ro,Z \
  -v "$here/container-build.sh":/container-build.sh:ro,Z \
  -v "$(realpath "$out")":/out:Z \
  "$image" bash /container-build.sh
[[ -x "$out/engine/strata" && -x "$out/engine/strata-vision" ]] || { echo 'engine was not built' >&2; exit 1; }
