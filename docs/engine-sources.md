# Strata engine sources

XRIG's Strata engines are built from [`xrigpc/Strata`](https://github.com/xrigpc/Strata), a fork of upstream
[`Niko1221/Strata`](https://github.com/Niko1221/Strata). The fork's `main` follows upstream and is never committed
to. Each engine line is a branch that starts at an upstream release and carries our changes as **one commit per
change**. Each engine we build is an annotated **tag** on it. A profile pins the tag, its commit and its tree
(`docs/release-process.md`, "Engine source").

## Engines on 0.1.44.1 (upstream `296b59d2`, v0.1.44.1)

| Tag | Branch | Commit | Tree | What it is |
|---|---|---|---|---|
| `engine/0.1.44.1-node.3` | `xrig/v0.1.44-node3` | `b2e90c97cc85` | `0bd8a7d3` | PR #1937 (revision `047192e6`, its author's 14 commits) + the 5 xrig fixes. The same tree as the shipped `ssd-044-v2.patch` profile |
| `engine/0.1.44.1-node.4` | `xrig/v0.1.44-node4` | `269befc664c5` | `77daafd8` | node.3 + conv-buffer-mmap + tier-fixes-v2 + tier-notice + conv-buffer-pool v3. Not shipped |
| `engine/0.1.44.1-a-rc1` | `xrig/v0.1.44-a` | `1242d2318b4b` | `b0cc0e47` | node.3 + tier-fixes-v2 + tier-notice + tier-take-bound (A1). Candidate |

Archive tags: `archive/pr1937-pre-rebase-047192e6`, the PR revision our tier comes from (it is no longer on any
upstream ref), and `archive/office-prod-316afea9`, the shipped source as one squashed commit (the same tree as
node.3).

Profiles: `rx7900xtx-64g-strata044-fork-node3-gfx1100.json` and `rx7900xtx-64g-strata044-fork-a-gfx1100.json`,
both CANDIDATE and not for publishing. `rx7900xtx-64g-strata044-ssd-gfx1100.json`, which shipped, stays on
upstream + `patches/ssd-044-v2.patch`.

## Cutting a new engine

1. Branch from the engine it builds on, or from an upstream release tag for a new line:
   `xrig/v<upstream version>-<name>`.
2. One commit per change, authored as Pallav. The message says what changed, why, and what tested it. Commit
   messages and code are public: no rig names, hosts, addresses or paths.
3. Tag it: `git tag -a engine/<strata_version>-<name> -m "<what it is>"`, then push the branch and the tag. Never
   move or delete a tag that a profile names: cut a new one (`-rc2`, `node.5`, …). `fetch-inputs.sh` refuses a tag
   that names another commit than the profile.
4. Profile: `source.strata_repo` = the fork, `strata_ref` = the tag, `strata_commit` = `git rev-parse <tag>^{commit}`,
   `expected_tree` = `git rev-parse <tag>^{tree}`, no `patches`. Raise `unit_tests` counts to what the engine's
   tests print.
5. Upstream changes: start a new line from the new upstream release (`xrig/v0.2.3-…`) and carry the commits over.
   `git range-diff` shows how each one changed. Old lines stay as they are, so their tags stay buildable.
