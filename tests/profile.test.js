const {execFileSync} = require('child_process');
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const fail = m => { throw new Error(m); };
for (const profile of ['profiles/rx7900xtx-64g-strata-gfx1100.json', 'profiles/rx7900xtx-64g-strata044-ssd-gfx1100.json', 'profiles/rx7900xtx-64g-strata044-ssd-node-fixes-gfx1100.json']) {
  execFileSync('node', ['scripts/profile.js', profile], {cwd: root, stdio: 'inherit'});
  const p = JSON.parse(fs.readFileSync(path.join(root, profile)));
  if (p.engine_args.kv !== 'int8' || p.engine_args.spec !== 4 || p.engine_args.prefill !== 16384) fail('locked parameters changed');
  if (p.config.compatibility.min_ram_gb !== 60 || p.config.compatibility.min_vram_gb !== 24 || p.config.compatibility.require.gpu_arch[0] !== 'gfx1100') fail('XTX 64 GB gate changed');
  if (p.qualification.levels.some(l => l + 100 > p.engine_args.max_context)) fail('qualification level exceeds the context');
  if (p.config.client.integrations.context_tokens !== p.engine_args.max_context) fail('client context differs from the engine context');
  if (p.source.strata_version === '0.1.43.1' && p.sampling) fail('the 0.1.43.1 lane must not carry sampling: Vertex 1.1.0-rc.5 and earlier refuse it');
  if (p.source.strata_version === '0.1.43.1' && ['pcie_frac', 'adapt', 'draft', 'placement'].some(k => p.engine_args[k] !== undefined))
    fail('the 0.1.43.1 lane must not carry engine tuning: Vertex launches it on 0.1.44.1+ stacks only');
}

// Engine tuning: profile.js range-checks it as Vertex does; the config revision carries it in runtime.strata,
// and a profile without it assembles the same runtime.strata as before.
const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-profile-'));
const node = JSON.parse(fs.readFileSync(path.join(root, 'profiles/rx7900xtx-64g-strata044-ssd-gfx1100.json')));
const tuning = { pcie_frac: 0.3, adapt: { every: 2, swaps: 64, decay: 0.9, async: true, min_gain: 2 },
  draft: { lookup_chain: 3, suffix_draft: 0, mtp_max_t: 4 }, placement: { aux_cpus: '7,8,15', pool_workers: 0 } };
const writeProfile = (name, edit) => {
  const p = JSON.parse(JSON.stringify(node));
  Object.assign(p.engine_args, JSON.parse(JSON.stringify(tuning)));
  edit(p.engine_args);
  const file = path.join(tmp, name + '.json');
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
  return file;
};
const validates = file => { try { execFileSync('node', ['scripts/profile.js', file], {cwd: root, stdio: 'pipe'}); return true; } catch { return false; } };
const accepted = { all: () => {}, low: e => { e.pcie_frac = 0; e.adapt.every = 1; e.adapt.decay = 0.5; },
  high: e => { e.pcie_frac = 0.85; e.adapt.swaps = 96; e.draft.mtp_max_t = 8; e.placement.pool_workers = 64; },
  off: e => { e.placement.aux_cpus = 'off'; }, auto: e => { e.placement.aux_cpus = 'auto'; } };
for (const [name, edit] of Object.entries(accepted)) if (!validates(writeProfile('ok-' + name, edit))) fail(`tuning ${name} must validate`);
const rejected = {
  pcie: e => { e.pcie_frac = 0.86; }, every: e => { e.adapt.every = 0; }, swaps: e => { e.adapt.swaps = 97; },
  decay: e => { e.adapt.decay = 1; }, gain: e => { e.adapt.min_gain = 11; }, async: e => { e.adapt.async = 1; },
  lookup: e => { e.draft.lookup_chain = 8; }, suffix: e => { e.draft.suffix_draft = 9; }, mtp: e => { e.draft.mtp_max_t = 2.5; },
  workers: e => { e.placement.pool_workers = 65; }, empty: e => { e.adapt = {}; }, unknown: e => { e.draft.coupled_draft = true; },
  list: e => { e.adapt = [2]; },
};
for (const bad of ['', 'on', '7,', '7,,8', '7 8', '24-27', '07', '7;rm', 'auto,7', '1,'.repeat(32) + '1'])
  rejected[`aux_cpus ${JSON.stringify(bad)}`] = e => { e.placement.aux_cpus = bad; };
for (const [name, edit] of Object.entries(rejected)) if (validates(writeProfile('bad-' + name.replace(/\W/g, '_'), edit))) fail(`tuning ${name} must be refused`);

const baseFile = path.join(tmp, 'base.json');
fs.writeFileSync(baseFile, JSON.stringify({ schema_version: 3, id: node.config.id, version: '2026.01.01-base',
  model: { alias: node.model.model_name }, runtime: { engine: 'strata', ref: { stack_id: node.stack_id, version: 'v1' } } }));
const assemble = (profile, out) => {
  execFileSync('node', ['scripts/assemble-config-revision.js', '--profile', profile, '--base-config', baseFile, '--config-revision', '2026.01.02-test',
    '--metadata-base', 'https://example.invalid', '--out', path.join(tmp, out)], {cwd: root, stdio: 'pipe'});
  return JSON.parse(fs.readFileSync(path.join(tmp, out, 'config.json'))).runtime.strata;
};
const plain = assemble(path.join(root, 'profiles/rx7900xtx-64g-strata044-ssd-gfx1100.json'), 'plain');
if (Object.keys(plain).join() !== 'max_context,kv,kv_resident,prefill,spec,spec_min_p,expert_cache,vram_reserve_mib,vision') fail('untuned runtime.strata changed');
const tuned = assemble(writeProfile('tuned', () => {}), 'tuned');
const {pcie_frac, adapt, draft, placement, ...rest} = tuned;
if (JSON.stringify(rest) !== JSON.stringify(plain) || JSON.stringify({pcie_frac, adapt, draft, placement}) !== JSON.stringify(tuning))
  fail('tuned runtime.strata differs from the profile');
fs.rmSync(tmp, { recursive: true, force: true });
const publisher = fs.readFileSync(path.join(root, 'scripts/publish-supabase.sh'), 'utf8');
if (/catalogues\/v2|stacks\/v1/.test(publisher.replace(/^#.*$/mg, ''))) fail('publisher must never write v1/v2 feeds read by older Vertex builds');
console.log('profile contract passed');
