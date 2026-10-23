#!/usr/bin/env node
// Assembles the unsigned publication documents for one qualified Strata build:
//   stack.json           schema 2 stack descriptor (Vertex stacksetup)
//   config.json          schema 3 configuration (Vertex modelconfig)
//   catalogue-row.json   catalogues/v3 row (filled with the config digest)
//   assets.json          release assets to upload: [{name, path, sha256, size_bytes}]
// URLs are parameters so staging and production publish identical documents
// apart from where the bytes live.
//
// Usage: assemble-release.js --profile P --runtime-dir D --data-dir D --qualification Q
//          --release-tag T --config-revision R --asset-base URL --metadata-base URL
//          [--therock-url URL] --out DIR
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
for (const k of ['profile', 'runtime-dir', 'data-dir', 'qualification', 'release-tag', 'config-revision', 'asset-base', 'metadata-base', 'out'])
  if (!args[k]) throw new Error(`--${k} is required`);
const die = m => { throw new Error(m); };
const read = f => fs.readFileSync(f, 'utf8');
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const p = JSON.parse(read(args.profile));
const q = JSON.parse(read(args.qualification));
if (!q.passed || q.gpu_arch !== p.platform.gpu_arch || q.model !== p.model.model_name) die('qualification evidence did not pass for this profile');
const tag = args['release-tag'], revision = args['config-revision'];
if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(tag) || !/^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[a-z0-9.-]+$/.test(revision)) die('invalid release tag or config revision');
const assetBase = args['asset-base'].replace(/\/$/, ''), metaBase = args['metadata-base'].replace(/\/$/, '');
if (!/^https:\/\//.test(assetBase) || !/^https:\/\//.test(metaBase)) die('asset and metadata bases must be https');

// Runtime archive: the single tar.gz produced by package-runtime.sh.
const runtimeDir = args['runtime-dir'];
const runtimeName = fs.readdirSync(runtimeDir).find(n => n.startsWith(p.asset_prefix + '-') && n.endsWith('.tar.gz')) || die('runtime archive missing');
const runtimePath = path.join(runtimeDir, runtimeName);
// Pin entry points, engine binaries and the Strata source (not every stdlib file).
const fileDigests = read(path.join(runtimeDir, 'runtime-files.sha256')).trim().split('\n').map(l => {
  const m = l.match(/^([0-9a-f]{64})  (.+)$/) || die('bad runtime-files line');
  return { path: m[2], sha256: m[1] };
}).filter(f => f.path.startsWith('runtime/strata/') || f.path.startsWith('runtime/lib/') || f.path === 'runtime/python/bin/python3.12');
const pyExe = 'runtime/python/bin/python3.12', engineExe = 'runtime/strata/engine/strata';
for (const need of [pyExe, engineExe, 'runtime/strata/engine/strata-vision', 'runtime/strata/serve/server.py', 'runtime/strata/' + p.engine_args.expert_profile, 'runtime/strata/' + p.engine_args.hipblaslt_tuning])
  if (!fileDigests.some(f => f.path === need)) die(`runtime closure lacks ${need}`);

const descriptor = {
  schema_version: 2, stack_id: p.stack_id, version: tag, os: p.platform.os, arch: p.platform.arch, vendor: 'amd', backend: 'rocm',
  label: p.label, executable: pyExe, backend_file: engineExe,
  library_dirs: [...p.therock.library_dirs, 'runtime/lib'],
  environment: {
    ROCM_PATH: '${STACK_ROOT}/rocm', HIP_PATH: '${STACK_ROOT}/rocm',
    STRATA_HIPBLASLT_TUNING: '${STACK_ROOT}/runtime/strata/' + p.engine_args.hipblaslt_tuning,
  },
  gpu_arch: p.platform.gpu_arch,
  prerequisites: { cpu_features: ['avx2'] },
  artifacts: [
    { id: 'xrig-strata-runtime', url: `${assetBase}/${runtimeName}`, signature_url: `${assetBase}/${runtimeName}.sig`,
      sha256: sha(runtimePath), size_bytes: fs.statSync(runtimePath).size, format: 'tar.gz', destination: '.' },
    { id: 'amd-therock', url: args['therock-url'] || p.therock.url, sha256: p.therock.sha256, size_bytes: p.therock.size_bytes, format: 'tar.gz', destination: 'rocm' },
  ],
  files: fileDigests,
  engine: 'strata',
  entrypoint: { args: ['-I', '${STACK_ROOT}/runtime/strata/serve/server.py', '--engine', 'strata'], working_dir: '${STACK_ROOT}/runtime/strata' },
  source: { ...require('./source-pin').sourceRecord(p.source),
    llama_cpp_commit: p.source.llama_cpp_commit, therock_version: p.therock.version, python_version: p.python.version, build_image: p.build_image },
};

// Data archives: per-file manifests written by package-data.sh.
const dataDir = args['data-dir'];
const dataManifest = role => {
  const name = fs.readdirSync(dataDir).find(n => n.endsWith('.files.json') && n.includes(role === 'pack' ? '-pack-' : '-mtp-')) || die(`${role} data manifest missing`);
  const m = JSON.parse(read(path.join(dataDir, name)));
  const archive = path.join(dataDir, m.asset_name);
  if (sha(archive) !== m.sha256 || fs.statSync(archive).size !== m.size_bytes) die(`${role} archive does not match its manifest`);
  return { m, archive };
};
const pack = dataManifest('pack'), mtp = dataManifest('mtp');
const c = p.config, e = p.engine_args, model = p.model;
const hf = f => ({ type: 'huggingface', repo: model.repo, revision: model.revision, filename: f.filename, sha256: f.sha256, size_bytes: f.size_bytes });
const data = (role, d) => ({ role, directory: c.data_directories[role], url: `${assetBase}/${d.m.asset_name}`, sha256: d.m.sha256,
  size_bytes: d.m.size_bytes, format: 'tar.gz', files: d.m.files });
const config = {
  schema_version: 3, id: c.id, name: c.name, description: c.description, version: revision, status: c.status,
  gpu_profile: c.gpu_profile, is_factory_default: c.is_factory_default, compatibility: c.compatibility,
  model: { alias: model.model_name, primary: hf(model.shards[0]), shards: model.shards.slice(1).map(hf), mmproj: hf(model.mmproj),
    data: [data('pack', pack), data('mtp', mtp)] },
  runtime: { engine: 'strata', ref: { stack_id: p.stack_id, version: tag },
    strata: { max_context: e.max_context, kv: e.kv, kv_resident: e.kv_resident, prefill: e.prefill, spec: e.spec, spec_min_p: e.spec_min_p,
      expert_cache: e.expert_cache, vram_reserve_mib: e.vram_reserve_mib, vision: e.vision } },
  client: c.client, policy: c.policy,
};
for (const k of ['pcie_frac', 'adapt', 'draft', 'placement']) if (e[k] !== undefined) config.runtime.strata[k] = e[k];
// runtime.strata.env exists only in schema 4; a profile without it publishes schema 3 as before.
const schemaVersion = e.env !== undefined ? 4 : 3;
config.schema_version = schemaVersion;
if (e.env !== undefined) config.runtime.strata.env = e.env;
if (p.sampling) config.runtime.sampling = p.sampling;

fs.mkdirSync(args.out, { recursive: true });
const write = (name, obj) => fs.writeFileSync(path.join(args.out, name), JSON.stringify(obj, null, 2) + '\n');
write('stack.json', descriptor);
write('config.json', config);
const configPath = path.join(args.out, 'config.json');
write('catalogue-row.json', {
  id: c.id, config_version: revision, schema_version: schemaVersion, status: c.status, vendor: c.compatibility.vendor,
  gpu_tags: c.compatibility.gpu_match, os: c.compatibility.os, backend: c.compatibility.backend,
  min_vram_gb: c.compatibility.min_vram_gb, min_ram_gb: c.compatibility.min_ram_gb,
  config_url: `${metaBase}/configs/${c.id}/${revision}.json`, config_sha256: sha(configPath),
  updated_at: new Date().toISOString(), is_active: true, gpu_profile: c.gpu_profile, is_factory_default: c.is_factory_default,
});
write('assets.json', [
  { name: runtimeName, path: runtimePath, sha256: descriptor.artifacts[0].sha256, size_bytes: descriptor.artifacts[0].size_bytes },
  { name: pack.m.asset_name, path: pack.archive, sha256: pack.m.sha256, size_bytes: pack.m.size_bytes },
  { name: mtp.m.asset_name, path: mtp.archive, sha256: mtp.m.sha256, size_bytes: mtp.m.size_bytes },
]);
console.log(`assembled ${p.stack_id} ${tag} / ${c.id} ${revision} in ${args.out}`);
