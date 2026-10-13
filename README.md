# XRIG Strata releases

Release-control plane for XRIG's Strata engine lane: the frozen, qualified
Strata stack that Vertex deploys for **Qwen 3.8 Flash Next 125B MoE (IQ2_XS)**
on an **AMD RX 7900 XTX (24 GB) with 64 GB of system RAM**. Anything weaker is
refused by Vertex (`compatibility.require` + `min_vram_gb: 24` + `min_ram_gb: 60`).

Sibling of [`xrig-llama-server-releases`](https://github.com/xrigpc/xrig-llama-server-releases)
with the same rules: every source is pinned, every byte has a digest, versions
are immutable, metadata is signed with the XRIG Ed25519 release key, and the
catalogue is always the last write.

## What is pinned (`profiles/rx7900xtx-64g-strata-gfx1100.json`)

| Input | Pin |
|---|---|
| Strata | `Niko1221/Strata` `a0116b2782a5…` (v0.1.43.1, MIT) |
| ggml / mtmd | llama.cpp `3cf03257f219…` (zip sha256) |
| ROCm | AMD TheRock `7.10.0a20251120` gfx110X-dgpu tarball (sha256, size) |
| Python | python-build-standalone CPython 3.12.14 + jinja2, markupsafe, regex, pillow, psutil wheels (sha256) |
| Build image | `ubuntu:24.04@sha256:f610ab…` (glibc 2.39 floor, portable AVX2 build) |
| Model | HF `ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF@ed59f920…` IQ2_XS shards + mmproj (sha256) |
| Locked engine settings | spec 4, prefill 16384, KV int8, 131072 context, sequential (benchmarked in `parameters.md`) |

## Pipeline

| Step | Where | Script |
|---|---|---|
| Fetch + verify inputs | test rig | `scripts/fetch-inputs.sh` |
| Portable engine build (container) | test rig | `scripts/build-runtime.sh` → `container-build.sh` |
| Relocatable runtime archive | test rig | `scripts/package-runtime.sh` (reproducible) |
| Pack / MTP data archives | test rig | `scripts/package-data.sh` (checked against frozen hashes, < 2 GiB) |
| Qualification on XTX 64 GB | test rig | `tests/qualify-strata-xtx64.sh` → `qualification.json` |
| Staging end-to-end with Vertex | test rig | `scripts/staging/*`, `assemble-release.js`, `build-tree.sh` |
| GitHub release + signed metadata | xrig PC | `scripts/release-production.sh` |
| Supabase publication (catalogue last) | xrig PC | `scripts/publish-supabase.sh` |

Runtime and data archives are GitHub Release assets of this repository (each
under GitHub's 2 GiB asset limit). The ROCm runtime is AMD's own tarball,
model weights come from Hugging Face at pinned revisions, and only signed
metadata goes to Supabase: `stacks/v2/…`, `configs/<id>/<revision>.json`,
`catalogues/v3/index.json`. `stacks/v1` and `catalogues/v2` (read by older
Vertex builds) are never touched.

See [docs/release-process.md](docs/release-process.md).
