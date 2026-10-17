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
if (e.kv !== 'int8' || e.spec !== 4 || e.prefill !== 16384 || e.max_context !== 131072) die('engine_args differ from the locked parameters (parameters.md)');

if (process.argv[3]) {
  const value = process.argv[3].split('.').reduce((o, k) => o?.[k], p);
  if (value === undefined) process.exitCode = 2;
  else process.stdout.write(typeof value === 'object' ? JSON.stringify(value) : String(value));
}
