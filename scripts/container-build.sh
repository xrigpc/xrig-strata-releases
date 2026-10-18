#!/usr/bin/env bash
# Runs INSIDE the digest-pinned Ubuntu build container (see build-runtime.sh).
# Inputs: /in (read-only verified cache), /profile.json. Output: /out/{engine,build-env.txt}.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends g++ cmake ninja-build unzip ca-certificates python3 file >/dev/null

rocm=/opt/rocm
mkdir -p "$rocm" /build
tar -xzf /in/therock.tar.gz -C "$rocm"
clang="$rocm/lib/llvm/bin/clang++"
[[ -x "$clang" ]] || { echo 'TheRock archive has no HIP compiler' >&2; exit 1; }
bitcode=$rocm/lib/llvm/amdgcn/bitcode; [[ -d $bitcode ]] || bitcode=$rocm/amdgcn/bitcode
[[ -d $bitcode ]] || { echo 'TheRock archive has no device bitcode' >&2; exit 1; }

cp -a /in/strata-src /build/strata
src=/build/strata
rm -rf "$src/.git"
mkdir -p "$src/third_party"
unzip -q /in/llama.cpp.zip -x '*/tools/ui/*' -d /build/llama-unpack
mv /build/llama-unpack/* "$src/third_party/llama.cpp"
llama="$src/third_party/llama.cpp"

cmake_defs() { # profile cmake section -> -Dk=v list
  python3 -c 'import json,sys; d=json.load(open("/profile.json"))["cmake"][sys.argv[1]]; print("\n".join(f"-D{k}={v}" for k,v in d.items()))' "$1"
}
gpu_arch=$(python3 -c 'import json; print(json.load(open("/profile.json"))["platform"]["gpu_arch"])')
export HIP_PLATFORM=amd HIP_COMPILER=clang HIP_RUNTIME=rocclr ROCM_PATH=$rocm HIP_PATH=$rocm
export PATH="$rocm/bin:$rocm/lib/llvm/bin:$PATH" LD_LIBRARY_PATH="$rocm/lib"

mapfile -t engine_defs < <(cmake_defs engine)
cmake -G Ninja -S "$src" -B /build/build-hip "${engine_defs[@]}" \
  -DCMAKE_HIP_COMPILER="$clang" -DCMAKE_HIP_COMPILER_ROCM_ROOT="$rocm" -DCMAKE_PREFIX_PATH="$rocm" \
  -DCMAKE_HIP_FLAGS="--rocm-path=$rocm --rocm-device-lib-path=$bitcode" \
  -DSTRATA_GGML_DIR="$llama" -DCMAKE_HIP_ARCHITECTURES="$gpu_arch"
cmake --build /build/build-hip --target strata --parallel "${XRIG_BUILD_JOBS:-$(nproc)}"
mapfile -t unit_tests < <(python3 -c 'import json; [print(t["target"], t["checks"]) for t in json.load(open("/profile.json")).get("unit_tests", [])]')
for ut in "${unit_tests[@]}"; do
  read -r target checks <<< "$ut"
  cmake --build /build/build-hip --target "$target" --parallel "${XRIG_BUILD_JOBS:-$(nproc)}"
  bin=$(find /build/build-hip -maxdepth 3 -type f -name "$target" | head -1)
  [[ -x "$bin" ]] || { echo "unit test $target was not built" >&2; exit 1; }
  log=/out/unit-$target.log
  "$bin" > "$log" 2>&1 || { tail -20 "$log"; echo "unit test $target FAILED" >&2; exit 1; }
  grep -qw "$checks" "$log" || { tail -5 "$log"; echo "unit test $target: expected $checks checks" >&2; exit 1; }
  echo "unit test $target: pass ($checks checks)"
done

mapfile -t vision_defs < <(cmake_defs vision)
cmake -G Ninja -S "$src/tools/vision" -B /build/build-vision "${vision_defs[@]}" -DLLAMA_DIR="$llama"
cmake --build /build/build-vision --target strata-vision --parallel "${XRIG_BUILD_JOBS:-$(nproc)}"

mkdir -p /out/engine
cp /build/build-hip/strata /out/engine/strata
cp /build/build-vision/bin/strata-vision /out/engine/strata-vision
cp "$(g++ -print-file-name=libgomp.so.1)" /out/engine/libgomp.so.1
for b in /out/engine/strata /out/engine/strata-vision; do
  if readelf -d "$b" | grep -E '(RPATH|RUNPATH)'; then echo "host RPATH is forbidden: $b" >&2; exit 1; fi
done
grep -q -- '-march=native' /build/build-hip/build.ninja && { echo 'engine build used -march=native' >&2; exit 1; }
{
  echo "image_glibc: $(ldd --version | head -1)"
  echo "gxx: $(g++ --version | head -1)"
  echo "cmake: $(cmake --version | head -1)"
  echo "ninja: $(ninja --version)"
  echo "hip_clang: $("$clang" --version | head -1)"
  echo "strata_version: $(/out/engine/strata --version 2>&1 | head -1 || true)"
  for b in strata strata-vision; do
    echo "$b max GLIBC: $(objdump -T /out/engine/$b | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1)"
    echo "$b max GLIBCXX: $(objdump -T /out/engine/$b | grep -o 'GLIBCXX_[0-9.]*' | sort -uV | tail -1)"
  done
} > /out/build-env.txt
cat /out/build-env.txt
echo 'portable Strata engine build completed'
