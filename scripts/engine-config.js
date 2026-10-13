#!/usr/bin/env node
// Writes the Strata engine config (the JSON serve/server.py --config reads) for an
// extracted stack. This mirrors what Vertex's strata engine generates at launch.
// Usage: engine-config.js PROFILE STACK_ROOT MODEL_DIR PACK_DIR MTP_DIR LOG_FILE OUT_JSON
const fs = require('fs'), path = require('path');
const [profilePath, stack, modelDir, packDir, mtpDir, logFile, out] = process.argv.slice(2);
if (!out) throw new Error('usage: engine-config.js PROFILE STACK_ROOT MODEL_DIR PACK_DIR MTP_DIR LOG_FILE OUT_JSON');
const p = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const e = p.engine_args, s = path.join(stack, 'runtime', 'strata');
const shard = i => path.join(modelDir, path.basename(p.model.shards[i].filename));
const args = ['--pack', packDir, '--native', shard(0)];
if (p.model.shards.length > 1) args.push('--ple-gguf', shard(1));
args.push('--expert-profile', path.join(s, e.expert_profile), '--expert-cache', String(e.expert_cache),
  '--prefill', String(e.prefill), '--spec', String(e.spec), '--spec-min-p', String(e.spec_min_p),
  '--mtp', mtpDir, '--max-context', String(e.max_context), '--kv', e.kv, '--kv-resident', String(e.kv_resident));
if (e.vision.enabled) args.push('--vision');
args.push('--vram-reserve-mib', String(e.vram_reserve_mib));
const cfg = {
  exe: path.join(s, 'engine', 'strata'), args, cwd: s,
  tokenizer: path.join(packDir, 'tokenizer'), model_name: p.model.model_name, log: logFile,
  lib_dirs: [...p.therock.library_dirs.map(d => path.join(stack, d)), path.join(stack, 'runtime', 'lib')],
  port: 8088, backend: 'hip',
  env: { STRATA_HIPBLASLT_TUNING: path.join(s, e.hipblaslt_tuning) },
};
if (e.vision.enabled) cfg.vision = {
  exe: path.join(s, 'engine', 'strata-vision'), mmproj: path.join(modelDir, path.basename(p.model.mmproj.filename)),
  model: shard(0), gpu: e.vision.gpu, max_tokens: e.vision.max_tokens, threads: e.vision.threads,
};
fs.writeFileSync(out, JSON.stringify(cfg, null, 1) + '\n');
