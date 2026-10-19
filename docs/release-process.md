# Strata lane release process

Roles: the **test rig** (RX 7900 XTX, 64 GB, no production credentials) builds,
packages and qualifies. The **xrig PC** (production gateway: GitHub, Supabase,
release key) only publishes bytes the rig already qualified.

## 1. Build and qualify (test rig)

```bash
P=profiles/rx7900xtx-64g-strata-gfx1100.json
V=strata-<version>-<commit12>-therock-<rocm>-v<N>        # packaging version
scripts/fetch-inputs.sh   $P ~/xrig-dev/build-cache
scripts/build-runtime.sh  $P ~/xrig-dev/build-cache ~/xrig-dev/build-out
scripts/package-runtime.sh $P ~/xrig-dev/build-cache ~/xrig-dev/build-out $V ~/xrig-dev/pkg-out
scripts/package-data.sh <pack dir> pack-iq2_xs $V ~/xrig-dev/data-out <frozen sha256sums>
scripts/package-data.sh <mtp/rt dir> mtp-rt     $V ~/xrig-dev/data-out <frozen sha256sums>
tests/qualify-strata-xtx64.sh $P <runtime tar.gz> <therock tar.gz> <models> <pack> <mtp> > qualification.json
```

Qualification runs the packaged stack exactly as Vertex will (clean
environment, `python -I`, TheRock libraries only) and requires: health and
`loaded`, the served model id, a text answer with `reasoning_content`, a
vision answer, the engine's `(gfx1100)` device line, and the throughput floor
(mean decode ≥ 60 tok/s, every run ≥ 40, 32K prefill ≥ 1200 tok/s, at 16K,
32K and 126K context).

## 2. Staging end-to-end (test rig, throwaway key)

```bash
scripts/staging/staging-env.sh > ~/xrig-dev/staging.env && . ~/xrig-dev/staging.env
node scripts/assemble-release.js ... --asset-base $XRIG_STAGING_BASE_URL/releases/<tag> \
  --metadata-base $XRIG_STAGING_BASE_URL --therock-url $XRIG_STAGING_BASE_URL/amd/<therock>.tar.gz --out assembled
STAGING_BOOTSTRAP=1 scripts/build-tree.sh assembled staging-tree $XRIG_STAGING_BASE_URL
python3 scripts/staging/serve-tree.py staging-tree $STAGING_PORT $STAGING_HOME/server.crt $STAGING_HOME/server.key
```

Then build Vertex with `-tags vertexdev,vertexstaging`, install the stack with
`xrig-stack-helper`, and run `TestStagingStrataDeployment` (see Vertex
`docs/engines.md`). Also run `TestProductionLlamaRegression` to prove the
production llama configuration still deploys unchanged.

## 3. Publish (xrig PC)

```bash
scripts/release-production.sh $P <runtime dir> <data dir> qualification.json <tag> <config revision> --no-publish
# review the printed publication tree, then:
scripts/publish-supabase.sh <tree>
```

`release-production.sh` signature-checks the live `stacks/v2` index, merges
into it and into the live `catalogues/v3`, creates the immutable GitHub
release, re-downloads and compares every asset, and only then (without
`--no-publish`) publishes metadata. Order of Supabase writes: immutable stack
descriptor and config revision, then the signed `stacks/v2` index, then
`catalogues/v3` last.

Never replace a release asset, stack version, descriptor or config revision:
publish a new version instead.

## 4. Config-only revision (xrig PC, production workflow)
A new configuration revision on an already-published stack: the live revision's model, data archives and stack
are kept, so Vertex downloads nothing new. The lane profile's `engine_args`, `sampling`, `config.description` and
`config.client` are applied. Dispatch **Publish config revision** (`publish-config-revision.yml`) with:
- `base_revision`: the revision the catalogue lists now (the run refuses any other);
- `config_revision`: the new immutable revision;
- `profile`: the lane profile;
- `publish_metadata`.

The run checks the live catalogue row, the base config (signature and catalogue digest) and the signed `stacks/v2`
index, prints the old-vs-new diff, signs the new revision and publishes it with the catalogue row last.
Locally: `scripts/assemble-config-revision.js` then `scripts/build-tree.sh` (a tree without `stack.json` holds only
the config and the catalogue) and `scripts/publish-supabase.sh`.

`sampling` in a profile becomes the configuration's `runtime.sampling`. Vertex 1.1.0-rc.5 and earlier refuse a
Strata configuration that sets it, so only the Node lane (0.1.44.1) carries it; the contract test keeps it off the
0.1.43.1 lane.

`engine_args` may also set engine tuning, copied into `runtime.strata` only when present (a profile without it
assembles the same configuration as before): `pcie_frac` (0-0.85), `adapt` {`every` 1-16, `swaps` 0-96, `decay`
0.5-0.999, `async` bool, `min_gain` 0.5-10}, `draft` {`lookup_chain` 0-7, `suffix_draft` 0-8, `mtp_max_t` 0-8} and
`placement` {`aux_cpus` `off`, `auto` or CPU indices such as `7,8,15`; `pool_workers` 0-64}. `profile.js` checks the
same ranges as Vertex. Vertex launches them on 0.1.44.1+ stacks only, and 1.1.0-rc.6 and earlier refuse a
configuration that sets any of them, so they stay off the 0.1.43.1 lane. `engine-config.js` (qualification) does not
apply them.
