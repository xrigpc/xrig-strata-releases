#!/usr/bin/env bash
# Qualifies a packaged Strata runtime on the RX 7900 XTX 64 GB test rig with the exact documents that ship, launched
# as Vertex launches them: the stack unpacked as Vertex installs it (runtime archive + AMD TheRock), the stack.json and
# config.json from `assemble-release.js --qualification -` (the release's own inputs and URLs), and the command line,
# environment, engine config, OOM score and unit properties that vertex-launch-plan makes for them. vertex-launch-plan
# is the Vertex release-side tool, built from the Vertex release that will run this configuration. The engine runs in
# a transient scope of the user's systemd manager with the runtime unit's properties.
# Usage: qualify-strata-xtx64.sh PROFILE ASSEMBLED_DIR RUNTIME_ARCHIVE THEROCK_TARBALL MODEL_DIR PACK_DIR MTP_DIR > qualification.json
# Env: XRIG_LAUNCH_PLAN   the vertex-launch-plan binary (required)
#      XRIG_QUALIFY_PORT  the engine's port (default 18090). 8088 is the Vertex runtime's own port, and some rigs route
#                         it to the internet, so it is refused unless XRIG_QUALIFY_ALLOW_8088=1.
#      XRIG_QUALIFY_TMP   parent of the work directory, on the SSD; tmpfs is refused (default ~/.cache/xrig-qualify)
set -euo pipefail
usage='usage: qualify-strata-xtx64.sh PROFILE ASSEMBLED_DIR RUNTIME_ARCHIVE THEROCK_TARBALL MODEL_DIR PACK_DIR MTP_DIR (env: XRIG_LAUNCH_PLAN, XRIG_QUALIFY_PORT, XRIG_QUALIFY_TMP)'
profile=$(realpath "${1:?$usage}"); assembled=$(realpath "${2:?$usage}")
archive=$(realpath "${3:?$usage}"); therock=$(realpath "${4:?$usage}"); models=$(realpath "${5:?$usage}")
pack=$(realpath "${6:?$usage}"); mtp=$(realpath "${7:?$usage}")
planner=$(realpath "${XRIG_LAUNCH_PLAN:?set XRIG_LAUNCH_PLAN to the vertex-launch-plan binary}")
here=$(cd "$(dirname "$0")" && pwd)
port=${XRIG_QUALIFY_PORT:-18090}
[[ $port != 8088 || ${XRIG_QUALIFY_ALLOW_8088:-} == 1 ]] || { echo 'port 8088 is the Vertex runtime port; set XRIG_QUALIFY_ALLOW_8088=1 to use it' >&2; exit 2; }
[[ -z $(ss -Hltn "sport = :$port") ]] || { echo "port $port is in use" >&2; exit 2; }
parent=${XRIG_QUALIFY_TMP:-$HOME/.cache/xrig-qualify}
mkdir -p "$parent"
work=$(realpath "$(mktemp -d "$parent/strata-qualify.XXXXXX")")   # real path: /proc/<pid>/exe names resolved paths
stack=$work/stack models_dir=$work/models state=$work/state scope=xrig-qualify-${work##*.}.scope started=
# Processes running a file of this run's stack: the server and the engines it started.
stack_pids() { local p; for p in /proc/[0-9]*; do [[ $(readlink "$p/exe" 2>/dev/null) == "$stack"/* ]] && printf '%s ' "${p#/proc/}"; done; true; }
cleanup() {
  local rc=$? left=
  if [[ -n $started ]]; then
    systemctl --user stop "$scope" 2>/dev/null || true
    for _ in $(seq 1 30); do
      left=$(stack_pids)
      [[ -z $left ]] && break
      sleep 1
    done
  fi
  if [[ -n $left ]]; then
    echo "processes of this run are still running after 30 s: $left(work directory kept: $work)" >&2
    exit 1
  fi
  rm -rf "$work"
  exit "$rc"
}
trap cleanup EXIT
# The SSD conversation tier writes under the state directory, which Vertex keeps on the SSD.
[[ $(stat -f -c %T "$work") != tmpfs ]] || { echo "$parent is tmpfs; set XRIG_QUALIFY_TMP to a directory on the SSD" >&2; exit 2; }

# The launched bytes are the ones stack.json names: both archives by SHA-256 here, and every file stack.json pins by
# SHA-256 when vertex-launch-plan resolves the unpacked stack (it refuses any mismatch, as Vertex does for an installed
# stack). So the evidence's stack_sha256 covers what ran.
pinned() { node -e 'const a = require(process.argv[1]).artifacts.find(x => x.id === process.argv[2]);
  process.stdout.write(a ? a.sha256 : "")' "$assembled/stack.json" "$1"; }
for pair in "xrig-strata-runtime:$archive" "amd-therock:$therock"; do
  [[ $(sha256sum "${pair#*:}" | cut -d' ' -f1) == "$(pinned "${pair%%:*}")" ]] ||
    { echo "${pair#*:} is not the ${pair%%:*} archive stack.json pins" >&2; exit 1; }
done
mkdir "$stack" "$stack/rocm" "$models_dir"
tar -xzf "$archive" -C "$stack"
tar -xzf "$therock" -C "$stack/rocm"
node "$here/../scripts/qualify-models.js" "$assembled/config.json" "$models_dir" "$models" "$pack" "$mtp"
# Vertex's own launch, planned in the environment a service starts with.
env -i HOME="$HOME" PATH=/usr/bin:/bin "$planner" -config "$assembled/config.json" -stack "$stack" \
  -descriptor "$assembled/stack.json" -models "$models_dir" -state "$state" -port "$port" -out "$work/plan.json"
field() { node -e 'const v = require(process.argv[1])[process.argv[2]];
  process.stdout.write([].concat(v ?? []).map(s => s + "\0").join(""))' "$work/plan.json" "$1"; }
mapfile -d '' -t argv < <(field argv)
mapfile -d '' -t environment < <(field env)
dir=$(field dir | tr -d '\0')
adj=$(field oom_score_adj | tr -d '\0')
[[ $adj =~ ^-?[0-9]+$ ]] || { echo 'the launch plan has no oom_score_adj' >&2; exit 1; }
mapfile -d '' -t unit < <(node -e 'const u = require(process.argv[1]).unit || {};
  for (const k of Object.keys(u)) if (k !== "MemorySwapMax") throw new Error(`unit property ${k} is not checked here`);
  process.stdout.write(Object.entries(u).map(([k, v]) => `-p\0${k}=${v}\0`).join(""))' "$work/plan.json")
# As the runtime does: the engine runs under its unit's properties, with its OOM score raised to the plan's.
(cd "$dir" && { (( $(cat /proc/self/oom_score_adj) >= adj )) || echo "$adj" > /proc/self/oom_score_adj; } &&
  exec systemd-run --user --scope --quiet --unit="$scope" "${unit[@]}" env -i "${environment[@]}" "${argv[@]}") > "$work/server.out" 2>&1 &
pid=$! started=1
for _ in $(seq 1 120); do
  kill -0 "$pid" 2>/dev/null || { echo 'server exited before ready' >&2; tail -40 "$work/server.out" >&2; exit 1; }
  curl -sm5 "http://127.0.0.1:$port/health" | grep -q '"loaded": *true' && break
  sleep 5
done
# Prove the unit properties and OOM score held for every process of the run, and record what was measured.
cgroup=/sys/fs/cgroup$(systemctl --user show -p ControlGroup --value "$scope")
swap=$(cat "$cgroup/memory.swap.max")
[[ $swap == 0 ]] || { echo "MemorySwapMax=0 did not apply (memory.swap.max is $swap); the user manager must delegate the memory controller" >&2; exit 1; }
scores=$(while read -r p; do cat "/proc/$p/oom_score_adj"; done < "$cgroup/cgroup.procs" | sort -un | paste -sd,)
for s in ${scores//,/ }; do (( s >= adj )) || { echo "a process of the run has oom_score_adj $s, below $adj" >&2; exit 1; }; done
printf '{"memory_swap_max": "%s", "oom_score_adj": [%s]}\n' "$swap" "$scores" > "$work/unit.json"
rc=0
"$stack/runtime/python/bin/python3" -I "$here/qualify.py" "$profile" "$port" "$state/logs/strata-engine.log" > "$work/result.json" || rc=$?
node "$here/../scripts/qualification-record.js" "$work/result.json" "$assembled" "$work/plan.json" "$planner" "$work/unit.json"
exit "$rc"
