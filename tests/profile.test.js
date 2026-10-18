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
}
const publisher = fs.readFileSync(path.join(root, 'scripts/publish-supabase.sh'), 'utf8');
if (/catalogues\/v2|stacks\/v1/.test(publisher.replace(/^#.*$/mg, ''))) fail('publisher must never write v1/v2 feeds read by older Vertex builds');
console.log('profile contract passed');
