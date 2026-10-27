#!/usr/bin/env node
// Lays out a configuration's model files in a Vertex models directory, as links to the rig's copies: each model
// file under its file name, each data archive under its configured directory (Vertex's own layout).
// Usage: qualify-models.js CONFIG OUT_DIR MODEL_DIR PACK_DIR MTP_DIR
const fs = require('fs'), path = require('path');
const [configPath, out, modelDir, packDir, mtpDir] = process.argv.slice(2);
if (!mtpDir) throw new Error('usage: qualify-models.js CONFIG OUT_DIR MODEL_DIR PACK_DIR MTP_DIR');
const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const link = (target, name) => {
  if (!fs.existsSync(target)) throw new Error(`model input missing: ${target}`);
  fs.symlinkSync(target, path.join(out, name));
};
for (const f of [c.model.primary, ...(c.model.shards || []), ...(c.model.mmproj ? [c.model.mmproj] : [])])
  link(path.join(modelDir, path.basename(f.filename)), path.basename(f.filename));
const roles = { pack: packDir, mtp: mtpDir };
for (const d of c.model.data || []) {
  if (!roles[d.role] || path.basename(d.directory) !== d.directory) throw new Error(`unexpected data archive ${d.role} ${d.directory}`);
  link(roles[d.role], d.directory);
}
