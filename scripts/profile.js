#!/usr/bin/env node
// Validates a Strata lane profile and prints one field: profile.js PROFILE [dotted.field]
const fs = require('fs');
const profilePath = process.argv[2];
if (!profilePath) throw new Error('usage: profile.js PROFILE [field]');
const p = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const sha = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const commit = v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const size = v => Number.isSafeInteger(v) && v > 0;
const https = v => typeof v === 'string' && /^https:\/\//.test(v);
const die = m => { throw new Error(m); };

if (p.schema_version !== 1) die('profile schema_version must be 1');
for (const k of ['lane_id', 'stack_id', 'asset_prefix']) if (!/^[a-z0-9][a-z0-9.-]+$/.test(p[k] || '')) die(`invalid ${k}`);
if (p.engine !== 'strata') die('this repository publishes Strata lanes only');
if (p.platform?.os !== 'linux' || p.platform?.arch !== 'amd64' || !/^gfx[0-9a-f]{3,5}$/.test(p.platform?.gpu_arch || '')) die('invalid platform');
if (!/^docker\.io\/library\/ubuntu:[0-9.]+@sha256:[a-f0-9]{64}$/.test(p.build_image || '')) die('build_image must be a digest-pinned ubuntu image');

const s = p.source || {};
if (s.strata_repo !== 'https://github.com/Niko1221/Strata.git' || !commit(s.strata_commit) || !/^[0-9]+(\.[0-9]+){2,3}$/.test(s.strata_version || '')) die('invalid Strata source pin');
if (!commit(s.llama_cpp_commit) || s.llama_cpp_zip_url !== `https://github.com/ggml-org/llama.cpp/archive/${s.llama_cpp_commit}.zip` || !sha(s.llama_cpp_zip_sha256) || !size(s.llama_cpp_zip_size_bytes)) die('invalid llama.cpp source pin');

if (s.patches !== undefined) {
  if (!Array.isArray(s.patches) || !s.patches.length || !s.patches.every(x => /^patches\/[A-Za-z0-9_.-]+\.patch$/.test(x.file || '') && sha(x.sha256))) die('invalid source.patches');
  if (!/^[a-f0-9]{40}$/.test(s.expected_tree || '')) die('source.patches requires source.expected_tree (git write-tree)');
}
if (p.unit_tests !== undefined && (!Array.isArray(p.unit_tests) || !p.unit_tests.every(u => /^[a-z0-9_]+$/.test(u.target || '') && Number.isSafeInteger(u.checks) && u.checks > 0))) die('invalid unit_tests');

const t = p.therock || {};
if (!/^https:\/\/rocm\.nightlies\.amd\.com\/tarball\//.test(t.url || '') || !sha(t.sha256) || !size(t.size_bytes) || !Array.isArray(t.library_dirs) || !t.library_dirs.every(d => /^rocm(\/[a-z0-9_.-]+)*$/.test(d))) die('invalid AMD TheRock pin');

const py = p.python || {};
if (!/^https:\/\/github\.com\/astral-sh\/python-build-standalone\/releases\/download\//.test(py.url || '') || !sha(py.sha256) || !size(py.size_bytes) || !Array.isArray(py.wheels) || !py.wheels.every(w => https(w.url) && sha(w.sha256) && /\.whl$/.test(w.name))) die('invalid Python pin');

const engineCMake = p.cmake?.engine || {};
const required = { STRATA_ENABLE_HIP: 'ON', STRATA_ENABLE_CUDA: 'OFF', STRATA_PORTABLE: 'ON', CMAKE_HIP_ARCHITECTURES: p.platform.gpu_arch, CMAKE_BUILD_TYPE: 'Release' };
for (const [k, v] of Object.entries(required)) if (engineCMake[k] !== v) die(`required engine CMake option ${k}=${v} missing`);
if (p.cmake?.vision?.STRATA_PORTABLE !== 'ON') die('vision build must be portable');

const m = p.model || {};
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(m.repo || '') || !commit(m.revision)) die('invalid model repo pin');
const files = [...(m.shards || []), m.mmproj];
if (!m.shards?.length || files.some(f => !f || !sha(f.sha256) || !size(f.size_bytes) || !/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(f.filename))) die('invalid model file pin');
if (!commit(m.mtp_source?.revision)) die('invalid MTP source pin');

const e = p.engine_args || {};
// max_context: 131072 for the 0.1.43.1 lane, 262144 for Node (0.1.44.1 + the SSD conversation tier)
if (e.kv !== 'int8' || e.spec !== 4 || e.prefill !== 16384 || ![131072, 262144].includes(e.max_context)) die('engine_args differ from the locked parameters (parameters.md)');

// tuning (optional): engine_args pcie_frac, adapt, draft and placement become runtime.strata fields, launched by Vertex
// on 0.1.44.1+ stacks only (Vertex accepts them from the release after 1.1.0-rc.6; the ranges are Vertex's)
{
  const intIn = (x, lo, hi) => x === undefined || (Number.isSafeInteger(x) && x >= lo && x <= hi);
  const numIn = (x, lo, hi) => x === undefined || (typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi);
  const block = (name, keys) => {
    const v = e[name];
    if (v === undefined) return {};
    if (v === null || typeof v !== 'object' || Array.isArray(v) || !Object.keys(v).length || Object.keys(v).some(k => !keys.includes(k)))
      die(`engine_args.${name}: unknown field or no field`);
    return v;
  };
  const a = block('adapt', ['every', 'swaps', 'decay', 'async', 'min_gain']);
  const d = block('draft', ['lookup_chain', 'suffix_draft', 'mtp_max_t']);
  const pl = block('placement', ['aux_cpus', 'pool_workers']);
  if (!numIn(e.pcie_frac, 0, 0.85) ||
      !intIn(a.every, 1, 16) || !intIn(a.swaps, 0, 96) || !numIn(a.decay, 0.5, 0.999) || !numIn(a.min_gain, 0.5, 10) ||
      (a.async !== undefined && typeof a.async !== 'boolean') ||
      !intIn(d.lookup_chain, 0, 7) || !intIn(d.suffix_draft, 0, 8) || !intIn(d.mtp_max_t, 0, 8) ||
      (pl.aux_cpus !== undefined && (typeof pl.aux_cpus !== 'string' || pl.aux_cpus.length > 64 ||
        !/^(off|auto|(0|[1-9][0-9]{0,3})(,(0|[1-9][0-9]{0,3}))*)$/.test(pl.aux_cpus))) ||
      !intIn(pl.pool_workers, 0, 64))
    die('engine_args tuning values out of range');
}

// sampling (optional): runtime.sampling, Strata's defaults for requests that leave those fields out
// (Vertex accepts it for Strata from the release after 1.1.0-rc.5; the ranges are Vertex's)
if (p.sampling !== undefined) {
  const v = p.sampling, num = x => typeof x === 'number' && Number.isFinite(x);
  const keys = ['temp', 'top_p', 'top_k', 'min_p', 'presence_penalty', 'repeat_penalty'];
  if (typeof v !== 'object' || Object.keys(v).some(k => !keys.includes(k))) die('sampling: unknown field');
  if (!num(v.temp) || v.temp < 0 || v.temp > 5 || !num(v.top_p) || v.top_p < 0 || v.top_p > 1 ||
      !Number.isSafeInteger(v.top_k) || v.top_k < 0 || v.top_k > 1000000 ||
      (v.min_p !== undefined && (!num(v.min_p) || v.min_p < 0 || v.min_p > 1)) ||
      (v.presence_penalty !== undefined && (!num(v.presence_penalty) || v.presence_penalty < -2 || v.presence_penalty > 2)) ||
      (v.repeat_penalty !== undefined && (!num(v.repeat_penalty) || v.repeat_penalty < 0 || v.repeat_penalty > 10)))
    die('sampling values out of range');
}

if (process.argv[3]) {
  const value = process.argv[3].split('.').reduce((o, k) => o?.[k], p);
  if (value === undefined) process.exitCode = 2;
  else process.stdout.write(typeof value === 'object' ? JSON.stringify(value) : String(value));
}
