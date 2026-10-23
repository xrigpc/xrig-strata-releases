const {execFileSync} = require('child_process');
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const fail = m => { throw new Error(m); };
for (const profile of ['profiles/rx7900xtx-64g-strata-gfx1100.json', 'profiles/rx7900xtx-64g-strata044-ssd-gfx1100.json']) {
  execFileSync('node', ['scripts/profile.js', profile], {cwd: root, stdio: 'inherit'});
  const p = JSON.parse(fs.readFileSync(path.join(root, profile)));
  if (p.engine_args.kv !== 'int8' || p.engine_args.spec !== 4 || p.engine_args.prefill !== 16384) fail('locked parameters changed');
  if (p.config.compatibility.min_ram_gb !== 60 || p.config.compatibility.min_vram_gb !== 24 || p.config.compatibility.require.gpu_arch[0] !== 'gfx1100') fail('XTX 64 GB gate changed');
  if (p.qualification.levels.some(l => l + 100 > p.engine_args.max_context)) fail('qualification level exceeds the context');
  if (p.config.client.integrations.context_tokens !== p.engine_args.max_context) fail('client context differs from the engine context');
  if (p.source.strata_version === '0.1.43.1' && p.sampling) fail('the 0.1.43.1 lane must not carry sampling: Vertex 1.1.0-rc.5 and earlier refuse it');
  if (p.source.strata_version === '0.1.43.1' && p.engine_args.env !== undefined)
    fail('the 0.1.43.1 lane must not carry engine env: Vertex launches it on 0.1.44.1+ stacks only');
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

// Source pins: upstream Strata at a commit (+ patches), or an engine tag of the xrigpc/Strata fork (no patches, tree
// always). A release records upstream sources exactly as before, fork sources with their tag and tree.
{
  const forkFiles = ['profiles/rx7900xtx-64g-strata044-fork-node3-gfx1100.json', 'profiles/rx7900xtx-64g-strata044-fork-a-gfx1100.json'];
  for (const f of forkFiles) if (!validates(path.join(root, f))) fail(`${f} must validate`);
  const fork = JSON.parse(fs.readFileSync(path.join(root, forkFiles[1])));
  const sourceProfile = (name, from, edit) => {
    const p = JSON.parse(JSON.stringify(from));
    edit(p.source);
    const file = path.join(tmp, 'src-' + name + '.json');
    fs.writeFileSync(file, JSON.stringify(p, null, 2));
    return file;
  };
  const okSource = { fork: [fork, () => {}], upstream: [node, () => {}],
    upstreamNoPatches: [node, s => { delete s.patches; delete s.expected_tree; }] };
  for (const [name, [from, edit]] of Object.entries(okSource)) if (!validates(sourceProfile(name, from, edit))) fail(`source ${name} must validate`);
  const badSource = {
    forkNoTree: [fork, s => { delete s.expected_tree; }], forkPatches: [fork, s => { s.patches = node.source.patches; }],
    forkNoRef: [fork, s => { delete s.strata_ref; }], forkBranchRef: [fork, s => { s.strata_ref = 'xrig/v0.1.44-a'; }],
    forkOtherVersion: [fork, s => { s.strata_ref = 'engine/0.1.45-a-rc1'; }], forkShortCommit: [fork, s => { s.strata_commit = '1242d231'; }],
    unknownRepo: [node, s => { s.strata_repo = 'https://github.com/someone/Strata.git'; }],
    unknownRepoForkShaped: [fork, s => { s.strata_repo = 'https://github.com/someone/Strata.git'; }],
    upstreamRef: [node, s => { s.strata_ref = 'engine/0.1.44.1-node.3'; }], upstreamPatchesNoTree: [node, s => { delete s.expected_tree; }],
  };
  for (const [name, [from, edit]] of Object.entries(badSource)) if (validates(sourceProfile(name, from, edit))) fail(`source ${name} must be refused`);

  // assemble-release.js on tiny dummy artifacts: only the descriptor's source block is checked.
  const assembleSource = (profileFile, out) => {
    const p = JSON.parse(fs.readFileSync(profileFile)), dir = path.join(tmp, out), rt = path.join(dir, 'rt'), data = path.join(dir, 'data');
    fs.mkdirSync(rt, { recursive: true }); fs.mkdirSync(data);
    fs.writeFileSync(path.join(rt, p.asset_prefix + '-test.tar.gz'), 'runtime');
    const need = ['runtime/python/bin/python3.12', 'runtime/strata/engine/strata', 'runtime/strata/engine/strata-vision', 'runtime/strata/serve/server.py',
      'runtime/strata/' + p.engine_args.expert_profile, 'runtime/strata/' + p.engine_args.hipblaslt_tuning];
    fs.writeFileSync(path.join(rt, 'runtime-files.sha256'), need.map(n => '0'.repeat(64) + '  ' + n).join('\n') + '\n');
    for (const role of ['pack', 'mtp']) {
      const asset = `test-${role}.tar.gz`, bytes = Buffer.from(role);
      fs.writeFileSync(path.join(data, asset), bytes);
      fs.writeFileSync(path.join(data, `test-${role}-x.files.json`), JSON.stringify({ asset_name: asset, size_bytes: bytes.length, files: [],
        sha256: require('crypto').createHash('sha256').update(bytes).digest('hex') }));
    }
    fs.writeFileSync(path.join(dir, 'q.json'), JSON.stringify({ passed: true, gpu_arch: p.platform.gpu_arch, model: p.model.model_name }));
    execFileSync('node', ['scripts/assemble-release.js', '--profile', profileFile, '--runtime-dir', rt, '--data-dir', data, '--qualification', path.join(dir, 'q.json'),
      '--release-tag', 'test-tag', '--config-revision', '2026.01.05-test', '--asset-base', 'https://example.invalid/a', '--metadata-base', 'https://example.invalid/m',
      '--out', path.join(dir, 'out')], {cwd: root, stdio: 'pipe'});
    return JSON.parse(fs.readFileSync(path.join(dir, 'out', 'stack.json'))).source;
  };
  const legacy = assembleSource(path.join(root, 'profiles/rx7900xtx-64g-strata044-ssd-gfx1100.json'), 'asm-legacy');
  if (Object.keys(legacy).join() !== 'strata_repo,strata_commit,strata_version,llama_cpp_commit,therock_version,python_version,build_image' ||
      legacy.strata_repo !== node.source.strata_repo || legacy.strata_commit !== node.source.strata_commit) fail('an upstream source must be recorded as before');
  const forked = assembleSource(path.join(root, forkFiles[1]), 'asm-fork');
  if (forked.strata_repo !== 'https://github.com/xrigpc/Strata.git' || forked.strata_ref !== fork.source.strata_ref ||
      forked.strata_commit !== fork.source.strata_commit || forked.expected_tree !== fork.source.expected_tree) fail('a fork source must be recorded with its tag and tree');
}

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
const publisher = fs.readFileSync(path.join(root, 'scripts/publish-supabase.sh'), 'utf8');
if (/catalogues\/v2|stacks\/v1/.test(publisher.replace(/^#.*$/mg, ''))) fail('publisher must never write v1/v2 feeds read by older Vertex builds');
console.log('profile contract passed');

// Engine env: profile.js range-checks it as Vertex does; a profile with it assembles a schema 4 configuration and row
// with runtime.strata.env, and a profile without it stays schema 3.
{
  const envProfile = (name, env) => {
    const p = JSON.parse(JSON.stringify(node));
    p.engine_args.env = env;
    const file = path.join(tmp, name + '.json');
    fs.writeFileSync(file, JSON.stringify(p, null, 2));
    return file;
  };
  const okEnv = { all: { watchdog_s: 180, malloc_arena_max: 4, hsa_userptr_for_paged_mem: 0, pinned_staging_only: true },
    low: { watchdog_s: 60, malloc_arena_max: 1, hsa_userptr_for_paged_mem: 0 }, high: { watchdog_s: 600, malloc_arena_max: 16, hsa_userptr_for_paged_mem: 1 } };
  for (const [name, env] of Object.entries(okEnv)) if (!validates(envProfile('env-ok-' + name, env))) fail(`env ${name} must validate`);
  const badEnv = { empty: {}, list: [1], watchdog59: { watchdog_s: 59 }, watchdog601: { watchdog_s: 601 }, arena0: { malloc_arena_max: 0 },
    arena17: { malloc_arena_max: 17 }, userptr2: { hsa_userptr_for_paged_mem: 2 }, pinnedFalse: { pinned_staging_only: false },
    pinnedSize: { gpu_pinned_min_xfer_size: 1048576 }, raw: { STRATA_WATCHDOG_S: 120 }, preload: { LD_PRELOAD: '/tmp/x.so' },
    string: { watchdog_s: '120' } };
  for (const [name, env] of Object.entries(badEnv)) if (validates(envProfile('env-bad-' + name, env))) fail(`env ${name} must be refused`);
  const run = (profile, out) => {
    execFileSync('node', ['scripts/assemble-config-revision.js', '--profile', profile, '--base-config', baseFile, '--config-revision', '2026.01.03-env',
      '--metadata-base', 'https://example.invalid', '--out', path.join(tmp, out)], {cwd: root, stdio: 'pipe'});
    return { config: JSON.parse(fs.readFileSync(path.join(tmp, out, 'config.json'))), row: JSON.parse(fs.readFileSync(path.join(tmp, out, 'catalogue-row.json'))) };
  };
  const withEnv = run(envProfile('env-assemble', { watchdog_s: 180, malloc_arena_max: 4 }), 'env');
  if (withEnv.config.schema_version !== 4 || withEnv.row.schema_version !== 4 ||
      JSON.stringify(withEnv.config.runtime.strata.env) !== JSON.stringify({ watchdog_s: 180, malloc_arena_max: 4 })) fail('env must assemble schema 4');
  const { env, ...withoutEnvStrata } = withEnv.config.runtime.strata;
  if (JSON.stringify(withoutEnvStrata) !== JSON.stringify(plain)) fail('env changed other runtime.strata fields');
  const noEnv = run(path.join(root, 'profiles/rx7900xtx-64g-strata044-ssd-gfx1100.json'), 'noenv');
  if (noEnv.config.schema_version !== 3 || noEnv.row.schema_version !== 3 || 'env' in noEnv.config.runtime.strata) fail('a profile without env must stay schema 3');
  // A schema 4 base revision is accepted as the base of the next revision.
  const base4 = path.join(tmp, 'base4.json');
  fs.writeFileSync(base4, JSON.stringify({ ...JSON.parse(fs.readFileSync(baseFile)), schema_version: 4 }));
  execFileSync('node', ['scripts/assemble-config-revision.js', '--profile', envProfile('env-next', { watchdog_s: 120 }), '--base-config', base4,
    '--config-revision', '2026.01.04-env', '--metadata-base', 'https://example.invalid', '--out', path.join(tmp, 'env4')], {cwd: root, stdio: 'pipe'});
}
console.log('engine env tests passed');
fs.rmSync(tmp, { recursive: true, force: true });
