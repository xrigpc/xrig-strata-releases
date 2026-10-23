const assert = require('assert');
const { merge } = require('../scripts/catalogue-merge.js');
const row = (version, schema, extra = {}) => ({ id: 'qwen3.8-flash-next-strata-xtx64', config_version: version, schema_version: schema,
  vendor: 'amd', backend: 'rocm', gpu_profile: 'linux-amd-rx7900xtx-64g-rocm-gfx1100', is_active: true, is_factory_default: true, ...extra });
const ids = rows => rows.map(r => `${r.config_version}/${r.schema_version}`).sort().join(' ');
const v3 = '2026.10.22-strata-xtx64-iq3s-node.3', v4 = '2026.10.27-strata-xtx64-iq3s-node.3.1';

// Same schema: the new revision replaces the old one.
assert.strictEqual(ids(merge([row(v3, 3)], row('2026.10.23-b', 3))), '2026.10.23-b/3');
// A schema 4 revision keeps the id and sits beside the schema 3 one older Vertex builds keep using.
const both = merge([row(v3, 3)], row(v4, 4));
assert.strictEqual(ids(both), `${v3}/3 ${v4}/4`);
// A later schema 4 revision replaces only the schema 4 row.
assert.strictEqual(ids(merge(both, row('2026.10.28-c', 4))), `${v3}/3 2026.10.28-c/4`);

// Version order: a schema 4 revision must sort after the schema 3 one (Find takes the highest version).
assert.throws(() => merge([row(v3, 3)], row('2026.10.21-older', 4)), /must sort after/);
assert.throws(() => merge([row(v3, 3)], row(v3, 4)), /must sort after/);
// The node.10 trap: a counter alone does not order revisions.
assert.throws(() => merge([row('node.9', 3)], row('node.10', 4)), /must sort after/);
// A schema 3 revision that sorts before the schema 4 one (an rc.8-only fix) is allowed and replaces the schema 3 row.
assert.strictEqual(ids(merge(both, row('2026.10.26-fix', 3))), `2026.10.26-fix/3 ${v4}/4`);
// A schema 3 revision that sorts at or after the schema 4 one is refused, unless the schema 4 row is dropped on purpose.
assert.throws(() => merge(both, row('2026.10.29-d', 3)), /does not sort before/);
assert.throws(() => merge(both, row(v4, 3)), /does not sort before/);
assert.strictEqual(ids(merge(both, row('2026.10.29-d', 3), { dropSchema4: true })), '2026.10.29-d/3');

// Rows of other configurations are untouched.
const other = { ...row('2026.10.01-x', 3), id: 'other', gpu_profile: 'other-profile' };
assert.strictEqual(merge([other, row(v3, 3)], row(v4, 4)).length, 3);

// Defaults: groups 0 and 3 need exactly one; schema 4 and later at most one.
const trial = { ...row('2026.10.25-g1-trial', 4), id: 'trial-g1', is_factory_default: false };
assert.strictEqual(merge([row(v3, 3)], trial).length, 2);                                   // non-default v4 trial allowed
assert.strictEqual(ids(merge([row(v3, 3)], row(v4, 4, { is_factory_default: false }))), `${v3}/3 ${v4}/4`);
assert.throws(() => merge(both, { ...row('2026.10.25-y', 4), id: 'second' }), /2 schema group 4 factory defaults/);
assert.throws(() => merge([], row(v3, 3, { is_factory_default: false })), /no factory default/);
assert.throws(() => merge([row(v3, 3)], { ...row('2026.10.25-z', 3), id: 'second' }), /2 schema group 3 factory defaults/);

// A profile listed only in schema 4 still needs a default (the profile-level floor).
const v4only = { ...row('2026.10.25-v4only', 4), id: 'v4only', gpu_profile: 'v4-only-profile', is_factory_default: false };
assert.throws(() => merge([row(v3, 3)], v4only), /no factory default in any schema/);
assert.strictEqual(merge([row(v3, 3)], { ...v4only, is_factory_default: true }).length, 2);

// Only schema 3 and 4 rows belong in catalogues/v3.
assert.throws(() => merge([], row(v3, 2)), /schema 3 or 4/);
assert.throws(() => merge([], row(v3, 5)), /schema 3 or 4/);
assert.throws(() => merge({}, row(v3, 3)), /invalid/);
console.log('catalogue-merge tests passed');
