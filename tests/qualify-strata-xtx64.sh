#!/usr/bin/env bash
# Qualifies a packaged Strata runtime on the RX 7900 XTX 64 GB test rig, exactly as Vertex will
# run it: extracted stack (runtime archive + AMD TheRock), clean environment, python -I launcher.
# Usage: qualify-strata-xtx64.sh PROFILE RUNTIME_ARCHIVE THEROCK_TARBALL MODEL_DIR PACK_DIR MTP_DIR > qualification.json
set -euo pipefail
profile=$(realpath "${1:?usage: qualify-strata-xtx64.sh PROFILE RUNTIME_ARCHIVE THEROCK_TARBALL MODEL_DIR PACK_DIR MTP_DIR}")
archive=$(realpath "${2:?}"); therock=$(realpath "${3:?}"); models=$(realpath "${4:?}"); pack=$(realpath "${5:?}"); mtp=$(realpath "${6:?}")
here=$(cd "$(dirname "$0")" && pwd)
port=${XRIG_QUALIFY_PORT:-8088}
! curl -sm2 "http://127.0.0.1:$port/health" >/dev/null || { echo "port $port is busy" >&2; exit 2; }
stack=$(mktemp -d "${XRIG_QUALIFY_TMP:-/tmp}/strata-qualify.XXXXXX")
pid=; trap '[[ -n $pid ]] && kill "$pid" 2>/dev/null; wait 2>/dev/null; rm -rf "$stack"' EXIT
tar -xzf "$archive" -C "$stack"
mkdir "$stack/rocm" && tar -xzf "$therock" -C "$stack/rocm"
node "$here/../scripts/engine-config.js" "$profile" "$stack" "$models" "$pack" "$mtp" "$stack/engine.log" "$stack/engine.json"
py="$stack/runtime/python/bin/python3"
# Clean environment, as Vertex's stacksetup builds it: no inherited LD_*/ROCm/Python variables.
env -i HOME="$HOME" PATH=/usr/bin:/bin LD_LIBRARY_PATH="$stack/rocm/lib:$stack/rocm/lib/rocm_sysdeps/lib:$stack/runtime/lib" \
  "$py" -I "$stack/runtime/strata/serve/server.py" --engine strata --config "$stack/engine.json" \
  --host 127.0.0.1 --port "$port" > "$stack/server.out" 2>&1 &
pid=$!
for _ in $(seq 1 120); do
  kill -0 "$pid" 2>/dev/null || { echo 'server exited before ready' >&2; tail -40 "$stack/server.out" >&2; exit 1; }
  curl -sm5 "http://127.0.0.1:$port/health" | grep -q '"loaded": *true' && break
  sleep 5
done
"$py" -I "$here/qualify.py" "$profile" "$port" "$stack/engine.log"
