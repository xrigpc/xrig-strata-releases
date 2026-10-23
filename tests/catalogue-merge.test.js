const assert = require('assert');
const { merge } = require('../scripts/catalogue-merge.js');
const row = (version, schema, extra = {}) => ({ id: 'qwen3.8-flash-next-strata-xtx64', config_version: version, schema_version: schema,
  vendor: 'amd', backend: 'rocm', gpu_profile: 'linux-amd-rx7900xtx-64g-rocm-gfx1100', is_active: true, is_factory_default: true, ...extra });
const ids = rows => rows.map(r => `${r.config_version}/${r.schema_version}`).sort().join(' ');

// Same schema: the new revision replaces the old one.
assert.strictEqual(ids(merge([row('a', 3)], row('b', 3))), 'b/3');
// A schema 4 revision sits beside the schema 3 one older Vertex builds keep using.
const both = merge([row('a', 3)], row('b', 4));
assert.strictEqual(ids(both), 'a/3 b/4');
// A later schema 4 revision replaces only the schema 4 row.
assert.strictEqual(ids(merge(both, row('c', 4))), 'a/3 c/4');
// A schema 3 revision while a schema 4 row exists is refused, unless the schema 4 row is dropped on purpose.
assert.throws(() => merge(both, row('d', 3)), /has a schema 4 row/);
assert.strictEqual(ids(merge(both, row('d', 3), { dropSchema4: true })), 'd/3');
// Rows of other configurations are untouched.
const other = { ...row('x', 3), id: 'other', gpu_profile: 'other-profile' };
assert.strictEqual(merge([other, row('a', 3)], row('b', 4)).length, 3);
// At most one default per (vendor, gpu_profile, backend, schema); a listed schema needs one.
const second = { ...row('y', 4), id: 'second' };
assert.throws(() => merge(both, second), /2 schema 4 factory defaults/);
assert.throws(() => merge([row('a', 3)], row('b', 4, { is_factory_default: false })), /no factory default/);
// Only schema 3 and 4 rows belong in catalogues/v3.
assert.throws(() => merge([], row('b', 2)), /schema 3 or 4/);
assert.throws(() => merge([], row('b', 5)), /schema 3 or 4/);
assert.throws(() => merge({}, row('b', 3)), /invalid/);
console.log('catalogue-merge tests passed');
