#!/usr/bin/env node
// Merges one configuration's row into the catalogues/v3 rows.
// A row replaces only the row of the same id AND schema_version: a schema 4 revision is published beside the
// schema 3 one, which Vertex builds that know only schema 3 keep using (they skip schema 4 rows). Publishing a
// schema 3 row while a schema 4 row of that id exists is refused, because builds that read schema 4 would keep
// the older schema 4 revision; set dropSchema4 (DROP_SCHEMA4_ROW=1) to remove that row deliberately.
// Afterwards every active (vendor, gpu_profile, backend, schema_version) must have at most one factory default,
// and every gpu_profile with active rows must have a default in each schema it is listed in.
// Usage: catalogue-merge.js OUT EXISTING_OR_EMPTY ROW_FILE  (env DROP_SCHEMA4_ROW=1)
const fs = require('fs');

const schemaOf = r => r.schema_version ?? 3;

function merge(rows, row, { dropSchema4 = false } = {}) {
  if (!Array.isArray(rows)) throw Error('existing catalogues/v3 index is invalid');
  if (![3, 4].includes(row.schema_version)) throw Error(`catalogues/v3 takes schema 3 or 4 rows, not ${row.schema_version}`);
  const newer = rows.filter(r => r.id === row.id && schemaOf(r) > row.schema_version);
  if (newer.length && !dropSchema4)
    throw Error(`${row.id} has a schema ${schemaOf(newer[0])} row; publish this revision as schema ${schemaOf(newer[0])} too, ` +
      'or set DROP_SCHEMA4_ROW=1 to remove that row deliberately');
  const out = rows.filter(r => r.id !== row.id || (schemaOf(r) !== row.schema_version && !(dropSchema4 && schemaOf(r) > row.schema_version)));
  out.push(row);
  check(out);
  return out;
}

function check(rows) {
  const groups = new Map();
  for (const r of rows.filter(r => r.is_active)) {
    const key = [r.vendor, r.gpu_profile || '', r.backend, schemaOf(r)].join('\u0000');
    const g = groups.get(key) || { rows: 0, defaults: 0, profile: r.gpu_profile, schema: schemaOf(r) };
    g.rows++; if (r.is_factory_default) g.defaults++;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    if (g.defaults > 1) throw Error(`gpu_profile ${g.profile} has ${g.defaults} schema ${g.schema} factory defaults; expected one`);
    if (g.profile && g.defaults === 0) throw Error(`gpu_profile ${g.profile} has active schema ${g.schema} rows but no factory default`);
  }
}

module.exports = { merge, check };

if (require.main === module) {
  const [out, existing, rowFile] = process.argv.slice(2);
  const rows = existing && fs.existsSync(existing) ? JSON.parse(fs.readFileSync(existing)) : [];
  const row = JSON.parse(fs.readFileSync(rowFile));
  fs.writeFileSync(out, JSON.stringify(merge(rows, row, { dropSchema4: process.env.DROP_SCHEMA4_ROW === '1' }), null, 2) + '\n');
}
