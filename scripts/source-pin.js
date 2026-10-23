// The Strata source pin of a profile: upstream Strata at a commit (plus optional patch files, the shipped
// 0.1.44.1 lanes), or an engine tag of XRIG's fork, which carries our changes as commits (docs/engine-sources.md).
const UPSTREAM = 'https://github.com/Niko1221/Strata.git', FORK = 'https://github.com/xrigpc/Strata.git';
const sha = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const commit = v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const die = m => { throw new Error(m); };

// Throws on an invalid source block. The llama.cpp pin is profile.js's.
function checkSource(s) {
  if (![UPSTREAM, FORK].includes(s.strata_repo) || !commit(s.strata_commit) || !/^[0-9]+(\.[0-9]+){2,3}$/.test(s.strata_version || ''))
    die('invalid Strata source pin');
  if (s.strata_repo === FORK) {
    // The tag names the engine for people and the tag check; the commit is what is fetched; the tree is checked after.
    if (!/^engine\/[0-9]+(\.[0-9]+){2,3}-[a-z0-9][a-z0-9.-]*$/.test(s.strata_ref || '') || !s.strata_ref.startsWith(`engine/${s.strata_version}-`))
      die('a fork source needs source.strata_ref, the engine/<strata_version>-<name> tag');
    if (!commit(s.expected_tree)) die('a fork source needs source.expected_tree (the commit\'s tree)');
    if (s.patches !== undefined) die('a fork source takes no source.patches: the changes are commits in the fork');
    return;
  }
  if (s.strata_ref !== undefined) die('source.strata_ref is for fork sources only: upstream is pinned by commit');
  if (s.patches !== undefined) {
    if (!Array.isArray(s.patches) || !s.patches.length || !s.patches.every(x => /^patches\/[A-Za-z0-9_.-]+\.patch$/.test(x.file || '') && sha(x.sha256))) die('invalid source.patches');
    if (!commit(s.expected_tree)) die('source.patches requires source.expected_tree (git write-tree)');
  }
}

// What a release records about its source. Upstream pins keep exactly the fields they always had, so a rebuilt
// shipped profile gives the same descriptor; fork pins add the tag and the tree.
function sourceRecord(s) {
  const r = { strata_repo: s.strata_repo, strata_commit: s.strata_commit, strata_version: s.strata_version };
  if (s.strata_repo === FORK) Object.assign(r, { strata_ref: s.strata_ref, expected_tree: s.expected_tree });
  return r;
}

module.exports = { UPSTREAM, FORK, checkSource, sourceRecord };
