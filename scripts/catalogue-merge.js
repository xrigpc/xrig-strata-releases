#!/usr/bin/env node
// Merges one configuration's row into the catalogues/v3 rows.
// A schema 4 revision keeps the configuration's id and is published beside the schema 3 one: Vertex builds that know
// only schema 3 skip schema 4 rows and keep the schema 3 revision, while newer builds list both revisions of the id,
// sort them by version (a plain string compare) and use the highest. So:
//   - a row replaces only the row of the same id AND schema_version;
//   - a schema 4 row must have a higher version than the id's schema 3 row;
//   - a schema 3 row must have a lower version than the id's schema 4 row, unless dropSchema4 (DROP_SCHEMA4_ROW=1)
//     removes the schema 4 row deliberately.
// Revisions are date-first (2026.10.24-...), so string order is time order. Never rely on a trailing counter
// alone: "node.10" sorts before "node.9".
// Factory defaults per (vendor, gpu_profile, backend, schema group): schemas 1-2 form group 0, schema 3 and later
// each their own. Groups 0 and 3 need exactly one default while they have active rows; groups 4 and later at most
// one, so a non-default schema 4 trial revision may be listed. And every (vendor, gpu_profile, backend) with active
// rows needs at least one default across its groups, so a profile listed only in schema 4 still has one.
// Usage: catalogue-merge.js OUT EXISTING_OR_EMPTY ROW_FILE  (env DROP_SCHEMA4_ROW=1)
const fs = require('fs');

const schemaOf = r => r.schema_version ?? 3;
const groupOf = r => (schemaOf(r) >= 3 ? schemaOf(r) : 0);

function merge(rows, row, { dropSchema4 = false } = {}) {
  if (!Array.isArray(rows)) throw Error('existing catalogues/v3 index is invalid');
  if (![3, 4].includes(row.schema_version)) throw Error(`catalogues/v3 takes schema 3 or 4 rows, not ${row.schema_version}`);
  const same = rows.filter(r => r.id === row.id);
  let drop = () => false;
  if (row.schema_version === 4) {
    for (const r of same.filter(r => schemaOf(r) === 3))
      if (!(row.config_version > r.config_version))
        throw Error(`schema 4 revision ${row.config_version} of ${row.id} must sort after its schema 3 revision ${r.config_version}`);
  } else {
    for (const r of same.filter(r => schemaOf(r) > 3)) {
      if (row.config_version < r.config_version) continue;
      if (!dropSchema4)
        throw Error(`schema 3 revision ${row.config_version} of ${row.id} does not sort before its schema ${schemaOf(r)} revision ` +
          `${r.config_version}; set DROP_SCHEMA4_ROW=1 to remove that row deliberately`);
    }
    if (dropSchema4) drop = r => schemaOf(r) > 3;
  }
  const out = rows.filter(r => r.id !== row.id || (schemaOf(r) !== row.schema_version && !drop(r)));
  out.push(row);
  check(out);
  return out;
}

function check(rows) {
  const groups = new Map(), profiles = new Map();
  for (const r of rows.filter(r => r.is_active)) {
    const profileKey = [r.vendor, r.gpu_profile || '', r.backend].join('\u0000');
    const key = [profileKey, groupOf(r)].join('\u0000');
    const g = groups.get(key) || { defaults: 0, profile: r.gpu_profile, group: groupOf(r) };
    const p = profiles.get(profileKey) || { defaults: 0, profile: r.gpu_profile };
    if (r.is_factory_default) { g.defaults++; p.defaults++; }
    groups.set(key, g);
    profiles.set(profileKey, p);
  }
  for (const p of profiles.values())
    if (p.profile && p.defaults === 0) throw Error(`gpu_profile ${p.profile} has active rows but no factory default in any schema`);
  for (const g of groups.values()) {
    if (g.defaults > 1) throw Error(`gpu_profile ${g.profile} has ${g.defaults} schema group ${g.group} factory defaults; expected at most one`);
    if (g.profile && g.group <= 3 && g.defaults === 0)
      throw Error(`gpu_profile ${g.profile} has active schema group ${g.group} rows but no factory default`);
  }
}

module.exports = { merge, check };

if (require.main === module) {
  const [out, existing, rowFile] = process.argv.slice(2);
  const rows = existing && fs.existsSync(existing) ? JSON.parse(fs.readFileSync(existing)) : [];
  const row = JSON.parse(fs.readFileSync(rowFile));
  fs.writeFileSync(out, JSON.stringify(merge(rows, row, { dropSchema4: process.env.DROP_SCHEMA4_ROW === '1' }), null, 2) + '\n');
}
