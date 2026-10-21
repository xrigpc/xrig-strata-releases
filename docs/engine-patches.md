# Strata engine patches (Node lane)

The Strata engine shipped by this repository is upstream Strata at the pinned
commit plus the patches below. They are applied **in this order** by
`scripts/fetch-inputs.sh`, which checks each file's sha256 and then the patched
tree against `source.expected_tree`. The git history of `patches/` is the full
record: every version, including the ones that were superseded or reverted.

## Patch stack

Base: Strata 0.1.44.1 `296b59d2f73c8f04a805df29c2fa97655adace78`.

| # | File | What it does | Author | Status |
|---|------|--------------|--------|--------|
| 1 | `ssd-044-v2.patch` | SSD conversation tier | upstream PR #1937 + 5 xrig fixes (office-reviewed) | **Shipped** (profile `rx7900xtx-64g-strata044-ssd-gfx1100`, config node.2) |
| 2 | `conv-buffer-mmap.patch` | Memory-drift fix: each ≥1 MiB conversation buffer segment gets its own mmap/munmap, so freed RAM returns to the OS | XTX lane | Candidate |
| 3 | `tier-fixes-v2.patch` | Bounded tier waits (park 2 s, restore 30 s), write gate, rolling 24 h write budget `STRATA_CONV_DISK_DAY_MIB` | office | Candidate |
| 4 | `tier-notice.patch` | One log line when the daily write budget engages / frees | office | Candidate |
| 5 | `conv-buffer-pool.patch` (v3) | Reuse 16 MiB segment mappings to remove patch 2's ~0.8 s TTFT cost | XTX lane | Candidate, under test |

Patched tree after 1-5: `77daafd88d3edc902bb55406767c9fdb4124dc69`
(after 1 only: `0bd8a7d30a89b66c7ba4761440be7650fc1fe032`).

Superseded, kept in history only:
- `conv-buffer-thp.patch` (huge pages, 21-Oct): reverted. It made TTFT worse on DDR4 64 GB (likely compaction stalls).
- `conv-buffer-pool.patch` v1 and v2: replaced in place by v3 after office review.

## Profiles

- `profiles/rx7900xtx-64g-strata044-ssd-gfx1100.json`: **what ships.** Patch 1 only.
- `profiles/rx7900xtx-64g-strata044-ssd-node-fixes-gfx1100.json`: **candidate.** Patches 1-5, `conversation_disk_test` 136 checks. Not qualified; not for publishing.

## Evidence so far (21-22 Oct, test rigs B / C, RX 7900 XTX, TheRock 7.10a)

- **Patch 2:** six 4 h soaks pass the memory gate. MemAvailable min: sfinE rig C 2709 MiB, sfinF rig B 4100, sfinH rig B 4196, sfinG rig C 4236, sfinI rig B 4051, sfinI rig C 4062 (226 one-minute samples). Heap ≤282 MiB in all, 0 OOM.
  - R6 ×3 (sfinG, rig C): decode +7-16% token-weighted over shipped, **but 1-agent e2e misses the 3% line in 2 of 3 rounds** (−0.5 / −0.1 / −3.5%), from ~+0.8 s TTFT per turn. That is the reason for patch 5.
  - Reuse stress: no corruption at ≥711 address reuses.
  - (The 20-Oct containment soak C tested a different bundle and is not counted.)
- **Patch 3:** two 4 h tier-ON soaks, 0 stalls and 0 restarts, including the slow-drive rig that previously stalled.
  - On rig B the daily budget engaged ~1.3 h in, so tier writes ran for ~1.3 h of the 4 h. Full-duration tier writing is untested until a `DAY_MIB=0` run.
  - **Write budget:** a 5-year cap on a 220 TBW drive is ≤114,884 MiB/day. Node value **112640** (5.1 years at the continuous cap; agreed 3/3 on 22-Oct, replacing 21-Oct's 122880 = 4.68 years). Measured real use is ~50 GB/day, about 12 years.
- **Patch 4:** unit tests only.
- **Patch 5:** unit tests (also built and tested independently by the office). R6 and a 1 h memdiag running.

## Before the candidate replaces the shipped profile

Required, not yet done:
- paired qeval x4096 of the candidate build vs shipped (fingerprint `df7ca04fc12c09f6`, McNemar per suite). No patched engine has had one yet;
- an identity check: the same tokens as the unpatched engine on fresh greedy requests with the adaptive tier frozen;
- a restore-path check (`reuse.py`, tier frozen) on unpatched / candidate / candidate with pool 0: restore flip rate within the known class (~7-8 of 96), and pool on no worse than pool 0;
- R6 ×3 + a 4 h soak of the final build with all R7 gates;
- the BOM drive (Crucial P310) re-test;
- a real launch through Vertex;
- a build of this profile through `fetch-inputs.sh` / `build-runtime.sh`. Every lab build so far applied the same patch files by hand.

Then the shipped profile takes the candidate's `source.patches` and `expected_tree` in one commit. Publishing stays a Pallav decision.
