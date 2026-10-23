#!/usr/bin/env node
// Assembles a config-only revision: a new immutable configuration that keeps the live revision's model, data
// archives and stack (so Vertex downloads nothing new) and takes the lane profile's engine settings, sampling,
// description and client block. The caller fetches the live revision and checks its signature first.
//   config.json          schema 3 configuration (schema 4 when the profile sets engine_args.env)
//   catalogue-row.json   catalogues/v3 row (build-tree.sh fills the digest)
// Usage: assemble-config-revision.js --profile P --base-config FILE --config-revision R --metadata-base URL --out DIR
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
for (const k of ['profile', 'base-config', 'config-revision', 'metadata-base', 'out'])
  if (!args[k]) throw new Error(`--${k} is required`);
const die = m => { throw new Error(m); };
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const p = read(args.profile), base = read(args['base-config']), c = p.config, e = p.engine_args;
const revision = args['config-revision'], metaBase = args['metadata-base'].replace(/\/$/, '');
if (!/^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[a-z0-9.-]+$/.test(revision)) die('invalid config revision');
if (!/^https:\/\//.test(metaBase)) die('metadata base must be https');
if (![3, 4].includes(base.schema_version) || base.id !== c.id || base.runtime?.engine !== 'strata' || base.runtime?.ref?.stack_id !== p.stack_id)
  die('base config is not a revision of this lane');
if (base.version === revision) die('the new revision must differ from the base revision');
if (base.model?.alias !== p.model.model_name) die('base config serves a different model than the profile');

const config = {
  schema_version: 3, id: c.id, name: c.name, description: c.description, version: revision, status: c.status,
  gpu_profile: c.gpu_profile, is_factory_default: c.is_factory_default, compatibility: c.compatibility,
  model: base.model,
  runtime: { engine: 'strata', ref: base.runtime.ref,
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
write('config.json', config);
const configPath = path.join(args.out, 'config.json');
write('catalogue-row.json', {
  id: c.id, config_version: revision, schema_version: schemaVersion, status: c.status, vendor: c.compatibility.vendor,
  gpu_tags: c.compatibility.gpu_match, os: c.compatibility.os, backend: c.compatibility.backend,
  min_vram_gb: c.compatibility.min_vram_gb, min_ram_gb: c.compatibility.min_ram_gb,
  config_url: `${metaBase}/configs/${c.id}/${revision}.json`,
  config_sha256: crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex'),
  updated_at: new Date().toISOString(), is_active: true, gpu_profile: c.gpu_profile, is_factory_default: c.is_factory_default,
});
console.log(`assembled ${c.id} ${revision} on ${base.runtime.ref.stack_id}/${base.runtime.ref.version} (base ${base.version}) in ${args.out}`);
