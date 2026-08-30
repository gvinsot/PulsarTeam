// ── GitHub activity, repo browsing, commit diffs, code graph ────────────────
//
// Most of this group is GitHub's own contract forwarded with a thin rename layer.
// Where the API maps field by field the evidence is a producer line; where it
// forwards an object untouched (CommitDiff.stats) the shape is INFERRED from
// GitHub's documented contract and says so.
//
// The two UI-local shapes at the bottom (RepoFileTreeNode, RepoExplorerFileState)
// live here rather than in ui.ts because they are derived from these payloads and
// are meaningless without them.

import type { LlmProvider } from './config';

/** GitHub git-trees entry type, forwarded without narrowing. 'commit' means a
 *  submodule gitlink; the explorer only tests `=== 'tree'`, so a submodule
 *  currently renders as a file. */
export type GitHubTreeEntryType = 'blob' | 'tree' | 'commit';

/** GitHub contents-API type, forwarded without narrowing. */
export type GitHubContentType = 'file' | 'dir' | 'symlink' | 'submodule';

/**
 * GitHub's documented closed set for a changed file. The frontend's FILE_STATUS
 * lookup only covers the first five, so 'changed' and 'unchanged' silently render
 * the 'modified' badge.
 */
export type CommitFileStatus =
  'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';

/** Layer of a call-graph node — declared and enforced server-side, and any
 *  out-of-set value returned by the refining LLM is coerced back to 'ui'. */
export type CodeGraphLayer = 'ui' | 'api-client' | 'route' | 'service';

/** Echo of the request body, coerced server-side: anything other than
 *  'service-to-ui' becomes 'ui-to-service'. */
export type CodeGraphDirection = 'ui-to-service' | 'service-to-ui';

/**
 * One commit in the 30-day activity feed.
 * Produced by api/src/routes/projects.ts:470.
 */
export interface GitHubActivityCommit {
  sha: string;
  /** sha.substring(0, 7). */
  shortSha: string;
  /** FIRST LINE ONLY. The full body is not on the wire here — contrast
   *  CommitDiff.message, which is the whole message. */
  message: string;
  /** Falls back through commit.author?.name → author?.login → the literal
   *  'Unknown' (capital U — CommitDiff uses lowercase 'unknown'). */
  author: string;
  /** Explicit null (key always present) when GitHub could not attribute the
   *  commit to an account. */
  authorAvatar: string | null;
  /** OPTIONAL, not nullable: there is no `|| null` tail, so when neither the
   *  author nor the committer date exists the key is dropped by JSON.stringify. */
  date?: string;
  /** Raw passthrough of GitHub's html_url. */
  url: string;
}

/**
 * One tag/release marker in the activity feed.
 * Produced by api/src/routes/projects.ts:482.
 */
export interface GitHubActivityTag {
  name: string;
  /** The tagged COMMIT sha, joined against GitHubActivityCommit.sha to render
   *  tags inline. */
  sha: string;
  shortSha: string;
  /** SYNTHESIZED server-side as
   *  https://github.com/:owner/:repo/releases/tag/<name> — not GitHub's tag API
   *  url. */
  url: string;
}

/**
 * GET /api/projects/github-activity/:owner/:repo — the last 30 days of commits
 * plus the 20 most recent tags, served from a 60s in-memory cache.
 * Produced by api/src/routes/projects.ts:490.
 *
 * The handler SWALLOWS GitHub failures: a 401 from a revoked token, a 403
 * rate-limit and an empty repo all return HTTP 200 with `commits: []`, and the
 * empty result is then cached for 60s. There is no discriminator for that.
 */
export interface GitHubActivityResponse {
  commits: GitHubActivityCommit[];
  tags: GitHubActivityTag[];
  /** ISO 8601. On a cache hit this is the timestamp of the ORIGINAL build, not of
   *  the request. */
  fetchedAt: string;
}

/**
 * One branch of the repo. GET /api/projects/github-branches/:owner/:repo returns
 * a BARE GitHubBranch[] with no envelope.
 * Produced by api/src/routes/projects.ts:520.
 */
export interface GitHubBranch {
  name: string;
  /** Produced but never read by any frontend consumer today. */
  sha: string;
}

/**
 * One flat entry of the recursive GitHub git-tree.
 * Produced by api/src/routes/projects.ts:550.
 */
export interface GitHubTreeEntry {
  /** Full slash-separated path from the repo root. */
  path: string;
  type: GitHubTreeEntryType;
  /** `item.size || 0` — GitHub omits size on tree entries, so the API coerces it
   *  and the key is always present. */
  size: number;
  /** Produced but never read by the explorer UI. */
  sha: string;
}

/**
 * GET /api/projects/github-tree/:owner/:repo/:ref.
 * Produced by api/src/routes/projects.ts:556.
 */
export interface GitHubTreeResponse {
  tree: GitHubTreeEntry[];
  /** `!!data.truncated` — the repo tree exceeded GitHub's limit, so the listing is
   *  PARTIAL. Produced but never read by the explorer, which therefore renders a
   *  truncated tree as if it were complete. */
  truncated: boolean;
}

/**
 * GET /api/projects/github-file/:owner/:repo/:ref/* — one file's decoded content
 * plus its GitHub links. Produced by api/src/routes/projects.ts:604-613.
 *
 * SIX of the eight keys are UNMAPPED PASSTHROUGHS (`name: data.name`,
 * `path: data.path`, `size: data.size`, `type: data.type`,
 * `htmlUrl: data.html_url`, `downloadUrl: data.download_url`) with no `|| null`
 * tail anywhere. The route also forwards the DIRECTORY response of the same
 * GitHub endpoint, where `data` is an ARRAY — so on that branch all six read
 * `undefined` off the array and JSON.stringify DROPS the keys. They are optional,
 * not nullable-with-a-present-key.
 *
 * Only `content` and `isBinary` are computed locally and therefore guaranteed.
 *
 * There is NO `error` key on a 200 body; see RepoExplorerFileState for where the
 * one the UI reads actually comes from.
 */
export interface GitHubFileContent {
  /** ABSENT on a directory response (see above). */
  name?: string;
  /** ABSENT on a directory response. */
  path?: string;
  /** ABSENT on a directory response. */
  size?: number;
  /** ABSENT on a directory response. */
  type?: GitHubContentType;
  /** Initialised to null and only assigned on a successful base64 decode, so it
   *  is null for binary files and for directory responses. Always PRESENT. */
  content: string | null;
  /** true when the base64 decode threw, or when GitHub returned a download_url
   *  instead of inline content. Always present. */
  isBinary: boolean;
  /** OPTIONAL *and* nullable: absent on the directory branch, and GitHub itself
   *  documents html_url as nullable on the file branch. */
  htmlUrl?: string | null;
  /** Same two cases as htmlUrl: absent on the directory branch, and GitHub sends
   *  an explicit null download_url for submodules and symlinks. */
  downloadUrl?: string | null;
}

/**
 * Aggregate line counts for one commit — GitHub's own stats object, forwarded
 * UNTOUCHED (`stats: commit.stats`), so this shape is inferred from GitHub's
 * single-commit contract rather than from per-field mapping code.
 */
export interface CommitDiffStats {
  additions: number;
  deletions: number;
  total: number;
}

/**
 * One changed file inside a commit diff, with its unified patch.
 * Produced by api/src/routes/tasks.ts:1005.
 */
export interface CommitDiffFile {
  filename: string;
  status: CommitFileStatus;
  additions: number;
  deletions: number;
  /** Always mapped, so always present (the consumer declares it optional and
   *  never reads it). */
  changes: number;
  /** `f.patch || ''` — ALWAYS a string, empty for binary files or when GitHub
   *  omitted the patch. Neither optional nor nullable; renderPatch already treats
   *  '' as "No diff available". */
  patch: string;
}

/**
 * GET /api/tasks/:id/commits/:hash/diff — one commit's metadata, stats and
 * per-file patches, proxied from GitHub with the board's OAuth token.
 * Produced by api/src/routes/tasks.ts:999.
 */
export interface CommitDiff {
  /** Full 40-char sha as GitHub resolved it — may be longer than the short hash
   *  the caller passed in the URL. */
  sha: string;
  /** FULL commit message including the body. */
  message: string;
  /** Falls back to the literal 'unknown' (lowercase here, 'Unknown' in the
   *  activity mapper — the two endpoints disagree on the sentinel). */
  author: string;
  /** OPTIONAL, not nullable: no null tail, so undefined drops the key. */
  date?: string;
  /** Optional because it is an unmapped passthrough — if GitHub omits it the key
   *  is dropped. */
  stats?: CommitDiffStats;
  /** `(commit.files || []).map(...)` — always an array. */
  files: CommitDiffFile[];
}

/**
 * One node of the call graph — a UI feature, an api-client method, a backend route
 * or a service. Produced by api/src/services/codeGraphAnalyzer.ts:272.
 */
export interface CodeGraphNode {
  /** Prefixed by layer: 'ui:', 'api:', 'route:', 'svc:'. */
  id: string;
  /** Capped at 80 chars after LLM refinement. */
  label: string;
  layer: CodeGraphLayer;
  /** addNode writes the key even when the value is undefined, so JSON drops it —
   *  optional, never null. It also DISAPPEARS from every node whenever a
   *  successful LLM refinement rebuilt them, i.e. whenever codeGraphLlmConfigId is
   *  configured. */
  file?: string;
}

/**
 * One directed edge of the call graph. pushEdge already swaps from/to according
 * to the requested `direction`, so the pair encodes the orientation.
 * Produced by api/src/services/codeGraphAnalyzer.ts:275.
 *
 * The GraphEdge interface server-side also declares an optional `label`, but
 * nothing ever populates it on either the heuristic or the LLM path — it is
 * deliberately not declared here.
 */
export interface CodeGraphEdge {
  from: string;
  to: string;
}

/** Coverage counters for one call-graph analysis run.
 *  Produced by api/src/services/codeGraphAnalyzer.ts:102. */
export interface CodeGraphStats {
  filesScanned: number;
  uiFiles: number;
  serviceFiles: number;
  /** From `!!treeData.truncated` on the GitHub git-trees call: the repo tree
   *  exceeded GitHub's limit, so the graph is partial. */
  truncated: boolean;
}

/** Identifies the LLM that post-processed the graph.
 *  Produced by api/src/services/codeGraphAnalyzer.ts:530
 *  (`llm: { provider: cfg.provider, model: cfg.model }`). */
export interface CodeGraphLlm {
  /** Copied VERBATIM from the admin-configured LlmConfig row, so it is the same
   *  value as LlmConfig.provider and carries the same type. The analyzer adds no
   *  constraint of its own — LlmProvider's `(string & {})` tail is what covers
   *  that. */
  provider: LlmProvider;
  model: string;
}

/**
 * POST /api/projects/code-graph/:owner/:repo — the heuristic UI↔service call graph
 * plus its Mermaid rendering.
 * Produced by api/src/services/codeGraphAnalyzer.ts:313, spread with fetchedAt and
 * ref in api/src/routes/projects.ts:707.
 *
 * `stats`, `fetchedAt` and `ref` are ALWAYS sent (the consumer currently declares
 * all three optional), and `llm` is NULLABLE-but-required — the distinction
 * matters, so it is kept here.
 */
export interface CodeGraphResponse {
  direction: CodeGraphDirection;
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  /** UNTRUSTED diagram source — built from repo contents and possibly rewritten by
   *  an LLM. Render it with mermaid securityLevel:'strict' and sanitize the SVG. */
  mermaid: string;
  stats: CodeGraphStats;
  /** Explicitly initialised to null, so the key is always present; replaced only
   *  when LLM refinement succeeded. */
  llm: CodeGraphLlm | null;
  /** ISO 8601. */
  fetchedAt: string;
  /** Echo of the requested ref, defaulted to 'main' server-side. */
  ref: string;
}

/**
 * POST /api/code-index/index-project — a fire-and-forget acknowledgement.
 * Produced by api/src/routes/codeIndex.ts:212.
 * The response is sent BEFORE indexing starts, so it never reports success or
 * failure.
 */
export interface CodeIndexProjectResponse {
  status: 'indexing';
  /** Echo of the request body, validated against /^[a-zA-Z0-9._-]{1,100}$/. */
  projectName: string;
}

/**
 * UI-LOCAL. The nested node buildNestedTree() derives from the flat
 * GitHubTreeEntry[]. Produced by GitHubActivityModal.tsx:730.
 */
export interface RepoFileTreeNode extends GitHubTreeEntry {
  /** Added client-side: the last '/'-separated segment of `path`. The API never
   *  sends it. */
  name: string;
  /** Written as `type === 'tree' ? [] : undefined`, so on file nodes the key
   *  EXISTS holding undefined. This is an in-memory object, never JSON, so keep
   *  the truthiness guard at the render site. */
  children?: RepoFileTreeNode[];
}

/**
 * UI-LOCAL. The union actually held by RepoExplorer's `fileContent` state: the
 * API payload, a locally-synthesised error object, or the initial null.
 *
 * Modelled as a union rather than as an extra optional field on GitHubFileContent
 * on purpose — the 200 body never carries an `error` key. The one the UI reads
 * comes from `.catch(err => setFileContent({ error: err.message }))`, and the
 * API's real 500 `{ error }` body is thrown by the api client long before it
 * could land in this state.
 */
export type RepoExplorerFileState = GitHubFileContent | { error: string } | null;

/**
 * UI-LOCAL. The {owner, repo} pair TasksBoard and ProjectDetailModal hold in state
 * to open GitHubActivityModal. Both derive it from `fullName.split('/')`, so a
 * fullName without a slash yields undefined halves — TasksBoard filters only on
 * fullName being truthy, ProjectDetailModal guards on both parts.
 */
export interface GitHubActivityTarget {
  owner: string;
  repo: string;
  /** Present only in TasksBoard's variant; never read by either consumer. */
  fullName?: string;
}
