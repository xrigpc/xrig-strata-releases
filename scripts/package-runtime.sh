#!/usr/bin/env bash
# Assembles the relocatable Strata runtime archive:
#   runtime/python/   python-build-standalone + jinja2/markupsafe (no pip, precompiled)
#   runtime/strata/   Strata serve/, tools/, data/, LICENSE, engine/{strata,strata-vision,BUILD.json}
#   runtime/lib/      libgomp.so.1 (strata-vision's OpenMP runtime)
# Usage: package-runtime.sh PROFILE CACHE_DIR BUILD_DIR RELEASE_VERSION OUT_DIR
set -euo pipefail
profile=${1:?usage: package-runtime.sh PROFILE CACHE_DIR BUILD_DIR RELEASE_VERSION OUT_DIR}
cache=${2:?}; build=${3:?}; version=${4:?}; out=${5:?}
here=$(cd "$(dirname "$0")" && pwd)
f() { node "$here/profile.js" "$profile" "$1"; }
[[ "$version" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$ && ! -e "$out" ]] || { echo 'invalid version or existing output' >&2; exit 2; }
[[ -x "$build/engine/strata" && -x "$build/engine/strata-vision" && -f "$build/engine/libgomp.so.1" ]] || { echo 'missing built engine' >&2; exit 1; }

root="$out/root"; rt="$root/runtime"
mkdir -p "$rt/lib" "$rt/strata/engine"
tar -xzf "$cache/python.tar.gz" -C "$rt"
py="$rt/python/bin/python3"
"$py" -I -m pip install --quiet --no-index --no-deps --no-compile --disable-pip-version-check "$cache"/wheels/*.whl
"$py" -I -m pip uninstall --quiet --yes pip
rm -f "$rt"/python/bin/pip* "$rt"/python/bin/idle* "$rt"/python/bin/2to3* "$rt"/python/bin/pydoc*
rm -rf "$rt"/python/lib/python3.*/{idlelib,tkinter,turtledemo,ensurepip,lib2to3} "$rt"/python/lib/{libtcl,libtk}* "$rt"/python/lib/tcl* "$rt"/python/lib/tk*
"$py" -I -c 'import jinja2, markupsafe, regex, psutil, PIL, sys; print("python", sys.version.split()[0], "jinja2", jinja2.__version__, "regex", regex.__version__, "pillow", PIL.__version__)'

src="$cache/strata-src"
cp -a "$src/serve" "$src/tools" "$src/data" "$src/LICENSE" "$rt/strata/"
find "$rt/strata" \( -name '__pycache__' -o -name '*.cu' \) -prune -exec rm -rf {} +
rm -rf "$rt/strata/tools/vision"
cp -a "$build/engine/strata" "$build/engine/strata-vision" "$rt/strata/engine/"
cp -a "$build/engine/libgomp.so.1" "$rt/lib/"
node - "$profile" "$rt/strata/engine/BUILD.json" <<'NODE'
const fs=require('fs');const p=JSON.parse(fs.readFileSync(process.argv[2]));
fs.writeFileSync(process.argv[3],JSON.stringify({source:'xrig-strata-releases',backend:'hip',version:p.source.strata_version,archs:[p.platform.gpu_arch],vision:'cpu',strata_commit:p.source.strata_commit,llama_cpp_commit:p.source.llama_cpp_commit,therock:p.therock.version,portable:true},null,1)+'\n');
NODE
cp "$build/build-env.txt" "$rt/strata/engine/BUILD-ENV.txt"
# Import smoke test: every module the server loads at startup must resolve from the stack alone.
(cd "$rt/strata" && "$py" -I -c 'import sys; sys.path[:0] = [".", "tools"]
import serve.server, serve.frontend, strata_tokenizer, make_profile, regex, psutil, PIL.Image, jinja2
print("runtime imports ok")')
SOURCE_DATE_EPOCH=0 "$py" -I -m compileall -q --invalidation-mode unchecked-hash "$rt/python/lib" "$rt/strata" >/dev/null

# Policy checks mirrored from Vertex stacksetup: no absolute or escaping links, no host RPATH.
while IFS= read -r link; do
  target=$(readlink "$link")
  [[ "$target" != /* ]] || { echo "absolute symlink forbidden: $link -> $target" >&2; exit 1; }
  resolved=$(realpath -m "$(dirname "$link")/$target")
  [[ "$resolved" == "$(realpath "$root")"/* ]] || { echo "escaping symlink: $link" >&2; exit 1; }
done < <(find "$root" -type l)
while IFS= read -r elf; do
  rp=$(readelf -d "$elf" 2>/dev/null | sed -n 's/.*(\(RPATH\|RUNPATH\)).*\[\(.*\)\]/\2/p')
  [[ -z "$rp" ]] && continue
  IFS=: read -ra entries <<<"$rp"
  for e in "${entries[@]}"; do [[ "$e" == '$ORIGIN'* || "$e" == '${ORIGIN}'* ]] || { echo "non-\$ORIGIN RPATH in $elf: $e" >&2; exit 1; }; done
done < <(find "$root" -type f \( -name '*.so*' -o -perm -u+x \) -exec sh -c 'head -c4 "$1" | grep -q ELF && echo "$1"' _ {} \;)

prefix=$(f asset_prefix); archive="$out/${prefix}-${version}.tar.gz"
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$root" -cf - runtime | gzip -n -9 > "$archive"
size=$(stat -c %s "$archive")
(( size < 2147483648 )) || { echo 'runtime archive exceeds the 2 GiB GitHub asset limit' >&2; exit 1; }
sha256sum "$archive" | awk '{print $1}' > "$archive.sha256"
echo "$size" > "$archive.size"
(cd "$root" && find runtime -type f -print0 | sort -z | xargs -0 sha256sum) > "$out/runtime-files.sha256"
echo "packaged $(basename "$archive") ($size bytes, $(wc -l < "$out/runtime-files.sha256") files)"
