// ─── Commit detection helpers ────────────────────────────────────────────────
// Pure functions that inspect a run_command tool result to detect git commit
// hashes. Extracted verbatim from _processToolCalls' host module.

/** Check if a command string represents a git operation that creates or moves commits */
export function _isGitMutatingCmd(rawCmd: string): boolean {
  if (!rawCmd.includes('git')) return false;
  if (/--dry-run|--help/.test(rawCmd)) return false;
  // Exclude read-only git commands that happen to be part of a chain
  // but keep commit, push, merge, cherry-pick, rebase, am, pull
  return /\b(commit|push|merge|cherry-pick|rebase|am|pull)\b/.test(rawCmd);
}

/** Check if git output indicates nothing actually happened */
export function _isGitNoop(output: string): boolean {
  return /nothing to commit/i.test(output) ||
    /everything up-to-date/i.test(output) ||
    /no changes added to commit/i.test(output) ||
    /nothing added to commit/i.test(output) ||
    /already up.to.date/i.test(output) ||
    /^current branch .+ is up to date/im.test(output);
}

/** Check if git output indicates a fatal error (should not try to link commits) */
export function _isGitError(output: string): boolean {
  return /^fatal:/im.test(output) ||
    /^error: failed to push/im.test(output) ||
    /rejected\b.*\bnon-fast-forward/i.test(output) ||
    /permission denied/i.test(output) ||
    /authentication failed/i.test(output) ||
    /could not read from remote/i.test(output) ||
    /unable to access/i.test(output) ||
    /not a git repository/i.test(output);
}

/** Check if git output suggests a successful operation */
export function _isGitSuccess(output: string): boolean {
  return (
    // git commit indicators
    /(\d+ files? changed|\d+ insertion|\d+ deletion|create mode|new file)/i.test(output) ||
    // git push indicators (ref update, new branch, new tag)
    /[a-f0-9]{7,}\.\.\.?[a-f0-9]{7,}\s+\S+\s*->\s*\S+/.test(output) ||
    /\[new branch\]/i.test(output) ||
    /\[new tag\]/i.test(output) ||
    /\[new ref\]/i.test(output) ||
    // git merge/rebase indicators
    /merge made by/i.test(output) ||
    /fast-forward/i.test(output) ||
    /successfully rebased/i.test(output) ||
    /applying:/i.test(output)
  );
}

/**
 * Detect commit hashes from a run_command tool call result.
 * Returns an array of { hash, msg } objects (may be empty).
 * Handles: git commit, git push (including push ranges), git merge,
 * git cherry-pick, git rebase, chained commands.
 */
export async function _detectCommitHashes(call: any, result: any, executionManager: any, agentId: string): Promise<Array<{ hash: string; msg: string }>> {
  if (typeof result.result !== 'string') return [];
  const rawCmd = (call.args[0] || '').toLowerCase();
  if (!_isGitMutatingCmd(rawCmd)) return [];

  const output = result.result;
  // Skip if the output indicates an error or nothing happened
  if (_isGitNoop(output)) return [];
  if (_isGitError(output)) return [];
  // Non-zero exit code: only skip if output has NO commit indicators.
  // Chained commands (e.g. "git commit && git push") can have exitCode != 0
  // when push fails but commit succeeded — we still want to capture the commit hash.
  if (result.meta?.exitCode && result.meta.exitCode !== 0) {
    if (!_isGitSuccess(output)) return [];
    console.log(`🔗 [Commit] Non-zero exit (${result.meta.exitCode}) but output has commit indicators — continuing detection`);
  }

  const commits: Array<{ hash: string; msg: string }> = [];
  const seenHashes = new Set<string>(); // prefix-aware dedup within this detection pass

  const _addCommit = (hash: string, msg: string) => {
    if (!hash || !/^[a-f0-9]{7,40}$/.test(hash)) return;
    // Prefix-aware dedup: check if we already have this hash (short or full)
    for (const seen of seenHashes) {
      if (seen === hash || seen.startsWith(hash) || hash.startsWith(seen)) {
        // If the new hash is longer (more precise), replace the shorter one
        if (hash.length > seen.length) {
          seenHashes.delete(seen);
          const idx = commits.findIndex(c => c.hash === seen);
          if (idx !== -1) { commits[idx].hash = hash; if (msg && !commits[idx].msg) commits[idx].msg = msg; }
          seenHashes.add(hash);
        }
        return;
      }
    }
    seenHashes.add(hash);
    commits.push({ hash, msg: (msg || '').slice(0, 200) });
  };

  // ── Pattern 1: git commit output — [branch hash] message ──
  const commitMatch = output.match(/\[[^\]]*\s([a-f0-9]{7,40})\]/);
  if (commitMatch) {
    let msg = '';
    const fullLineMatch = output.match(/\[[^\]]+\]\s+(.+)/);
    if (fullLineMatch) msg = fullLineMatch[1].trim();
    _addCommit(commitMatch[1], msg);
  }

  // ── Pattern 2: git push output — old..new branch -> branch ──
  // Also captures the range (old..new) for multi-commit push detection.
  const pushMatch = output.match(/\+?([a-f0-9]{7,40})\.\.\.?([a-f0-9]{7,40})\s+\S+\s*->\s*\S+/);
  let pushOldHash: string | null = null;
  let pushNewHash: string | null = null;
  if (pushMatch) {
    pushOldHash = pushMatch[1];
    pushNewHash = pushMatch[2];
    _addCommit(pushNewHash, '');
    console.log(`🔗 [Commit] Detected push range: ${pushOldHash.slice(0, 7)}..${pushNewHash.slice(0, 7)}`);
  }

  // ── Pattern 3: HEAD is now at <hash> (from rebase, cherry-pick, etc.) ──
  if (commits.length === 0) {
    const headMatch = output.match(/HEAD is now at ([a-f0-9]{7,40})/i);
    if (headMatch) _addCommit(headMatch[1], '');
  }

  // ── Fallback: query HEAD from execution environment ──
  // Covers: new branch pushes, unusual output formats, merge commits, etc.
  if (commits.length === 0 && executionManager?.hasEnvironment(agentId) && _isGitSuccess(output)) {
    try {
      const headResult = await executionManager.exec(agentId, 'git log --format="%H %s" -1', { timeout: 10000 });
      const headOutput = ((headResult.stdout || '') + (headResult.stderr || '')).trim();
      const headMatch = headOutput.match(/^([a-f0-9]{40})\s+(.*)/);
      if (headMatch) {
        _addCommit(headMatch[1], headMatch[2]);
        console.log(`🔗 [Commit] Fallback: captured HEAD ${headMatch[1].slice(0, 7)} via git log (cmd="${rawCmd.slice(0, 60)}")`);
      }
    } catch (e: any) {
      console.warn(`⚠️  [Commit] Fallback git log failed: ${e.message}`);
    }
  }

  // ── Resolve short hashes to full 40-char and fetch all commits in push range ──
  if (commits.length > 0 && executionManager?.hasEnvironment(agentId)) {
    // If we detected a push range, fetch ALL commits in that range
    if (pushOldHash && pushNewHash && commits.length <= 2) {
      try {
        const rangeResult = await executionManager.exec(agentId, `git log --format="%H %s" ${pushOldHash}..${pushNewHash}`, { timeout: 10000 });
        const rangeOutput = ((rangeResult.stdout || '') + (rangeResult.stderr || '')).trim();
        if (rangeOutput) {
          for (const line of rangeOutput.split('\n')) {
            const m = line.match(/^([a-f0-9]{40})\s+(.*)/);
            if (m) _addCommit(m[1], m[2]);
          }
          console.log(`🔗 [Commit] Push range: found ${commits.length} commit(s) in ${pushOldHash.slice(0, 7)}..${pushNewHash.slice(0, 7)}`);
        }
      } catch (e: any) {
        console.warn(`⚠️  [Commit] Push range log failed: ${e.message}`);
      }
    }

    // Resolve any remaining short hashes to full 40-char hashes
    for (const c of commits) {
      if (c.hash.length < 40) {
        try {
          const revResult = await executionManager.exec(agentId, `git rev-parse ${c.hash}`, { timeout: 5000 });
          const fullHash = ((revResult.stdout || '') + (revResult.stderr || '')).trim();
          if (/^[a-f0-9]{40}$/.test(fullHash)) {
            c.hash = fullHash;
          }
        } catch { /* keep short hash */ }
      }
    }
  }

  // Diagnostic: log when a git mutating command ran but no hash was detected
  if (commits.length === 0 && !_isGitNoop(output)) {
    console.warn(`⚠️  [Commit] No hash detected for git command. cmd="${rawCmd.slice(0, 120)}" output="${output.slice(0, 300)}"`);
  }

  return commits;
}
