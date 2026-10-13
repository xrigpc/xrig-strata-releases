#!/usr/bin/env bash
# Builds the signed publication tree for an assembled release, laid out exactly
# like the xrig-configs bucket (metadata) plus a releases/<tag>/ asset folder:
#   stacks/v2/<stack>-<version>.json(.sig), stacks/v2/index.json(.sig)
#   configs/<id>/<revision>.json(.sig), catalogues/v3/index.json
#   releases/<tag>/<assets> (+ runtime .sig)        [staging serves these itself]
# Existing indexes (downloaded from the live bucket) are merged, never replaced:
#   EXISTING_STACK_INDEX, EXISTING_CATALOGUE  (optional file paths)
# STAGING_BOOTSTRAP=1 also writes an empty signed stacks/v1 index and an empty
# catalogues/v2 index so a staging Vertex has every feed it reads.
# Signing: XRIG_ED25519_PRIVATE_KEY_B64 (see sign-artifact.sh).
# Usage: build-tree.sh ASSEMBLED_DIR TREE_DIR METADATA_BASE_URL
set -euo pipefail
assembled=$(realpath "${1:?usage: build-tree.sh ASSEMBLED_DIR TREE_DIR METADATA_BASE_URL}")
tree=${2:?}; base=${3:?}; base=${base%/}
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$tree"; tree=$(realpath "$tree")
field() { node -e 'const x=require(process.argv[1]);console.log(process.argv[2].split(".").reduce((o,k)=>o[k],x))' "$1" "$2"; }
stack_id=$(field "$assembled/stack.json" stack_id); version=$(field "$assembled/stack.json" version)
config_id=$(field "$assembled/config.json" id); revision=$(field "$assembled/config.json" version)

mkdir -p "$tree/stacks/v2" "$tree/configs/$config_id" "$tree/catalogues/v3" "$tree/releases/$version"
descriptor="$tree/stacks/v2/${stack_id}-${version}.json"
[[ ! -e "$descriptor" ]] || { echo "stack $stack_id/$version already exists: stack versions are immutable" >&2; exit 1; }
cp "$assembled/stack.json" "$descriptor"
"$here/sign-artifact.sh" "$descriptor"

node - "$tree/stacks/v2/index.json" "${EXISTING_STACK_INDEX:-}" "$descriptor" "$base" "$stack_id" "$version" <<'NODE'
const fs=require('fs'),crypto=require('crypto');const [out,existing,desc,base,stack,version]=process.argv.slice(2);
const index=existing&&fs.existsSync(existing)?JSON.parse(fs.readFileSync(existing)):{schema_version:2,stacks:[]};
if(index.schema_version!==2||!Array.isArray(index.stacks))throw Error('existing stacks/v2 index is invalid');
if(index.stacks.some(e=>e.stack_id===stack&&e.version===version))throw Error('stack version already listed');
const bytes=fs.readFileSync(desc),name=desc.split('/').pop(),url=`${base}/stacks/v2/${name}`;
index.stacks.push({stack_id:stack,version,descriptor_url:url,signature_url:url+'.sig',sha256:crypto.createHash('sha256').update(bytes).digest('hex'),size_bytes:bytes.length});
fs.writeFileSync(out,JSON.stringify(index,null,2)+'\n');
NODE
"$here/sign-artifact.sh" "$tree/stacks/v2/index.json"

config="$tree/configs/$config_id/$revision.json"
[[ ! -e "$config" ]] || { echo "config $config_id/$revision already exists: revisions are immutable" >&2; exit 1; }
cp "$assembled/config.json" "$config"
"$here/sign-artifact.sh" "$config"

node - "$tree/catalogues/v3/index.json" "${EXISTING_CATALOGUE:-}" "$assembled/catalogue-row.json" "$base" "$config" <<'NODE'
const fs=require('fs'),crypto=require('crypto');const [out,existing,rowFile,base,config]=process.argv.slice(2);
let rows=existing&&fs.existsSync(existing)?JSON.parse(fs.readFileSync(existing)):[];
if(!Array.isArray(rows))throw Error('existing catalogues/v3 index is invalid');
const row=JSON.parse(fs.readFileSync(rowFile));
row.config_url=`${base}/configs/${row.id}/${row.config_version}.json`;
row.config_sha256=crypto.createHash('sha256').update(fs.readFileSync(config)).digest('hex');
rows=rows.filter(r=>r.id!==row.id);rows.push(row);
fs.writeFileSync(out,JSON.stringify(rows,null,2)+'\n');
NODE

node -e 'for(const a of require(process.argv[1]))console.log(a.name+"\t"+a.path)' "$assembled/assets.json" |
while IFS=$'\t' read -r name src; do
  cp --reflink=auto "$src" "$tree/releases/$version/$name"
done
runtime=$(node -e 'console.log(require(process.argv[1])[0].name)' "$assembled/assets.json")
"$here/sign-artifact.sh" "$tree/releases/$version/$runtime"

if [[ "${STAGING_BOOTSTRAP:-0}" == 1 ]]; then
  mkdir -p "$tree/stacks/v1" "$tree/catalogues/v2"
  [[ -e "$tree/stacks/v1/index.json" ]] || { printf '%s\n' '{"schema_version":1,"stacks":[]}' > "$tree/stacks/v1/index.json"; "$here/sign-artifact.sh" "$tree/stacks/v1/index.json"; }
  [[ -e "$tree/catalogues/v2/index.json" ]] || printf '[]\n' > "$tree/catalogues/v2/index.json"
fi
echo "publication tree for $stack_id/$version and $config_id/$revision written to $tree"
