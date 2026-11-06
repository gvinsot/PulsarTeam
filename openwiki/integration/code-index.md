---
type: service
title: Code index
description: The built-in code index, which extracts symbols and a lexical reference graph per file, stores them as JSON on the API's disk, offers lexical and hashed-embedding search through MCP tools, and reports freshness with incremental sync.
tags: [code-index, search, mcp, embeddings, references]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-06T10:37:51.796Z
sources:
  - id: openwiki-source-f8a3d4690858d2e0388d948d
    resource: repo://api/src/services/agentManager/index.ts
  - id: openwiki-source-66eca6eed2f4cd2b925ab696
    resource: repo://api/src/services/codeIndexService.ts
  - id: openwiki-source-0f2aa571e03c04043971a0e4
    resource: repo://api/src/services/codeSearch/embedding.ts
  - id: openwiki-source-885515f90ffe07b9b9480144
    resource: repo://api/src/services/codeSearch/README.md
  - id: openwiki-source-a1ef1b627dc5669448112888
    resource: repo://api/src/services/codeSearch/referenceExtractor.ts
  - id: openwiki-source-6053e86a53d0daccbf0184f5
    resource: repo://api/src/services/codeSearch/vectorStore.ts
generated: { by: "claude-code", at: "2026-11-06T10:37:51.796Z" }
---

# Code index

The code index lets agents explore a repository without reading whole files. `CodeIndexService` (`api/src/services/codeIndexService.ts`) holds the logic, `codeIndexMcp.ts` exposes it as an MCP server at `/api/code-index/mcp`, and `routes/codeIndex.ts` serves the REST API. `api/src/services/codeSearch/README.md` is the detailed tool reference.

| Module in `codeSearch/` | Role |
|---|---|
| `symbolExtractor.ts` | Classes, functions and methods per file, based on regex and indentation |
| `referenceExtractor.ts` | Imports and identifier occurrences per file |
| `embedding.ts` | Hashed embeddings |
| `vectorStore.ts` | ZVEC store with an in-memory fallback |

## Storage

Each index is a JSON file at `.data/code-index/<repoId>/index.json` under `CODE_SEARCH_INDEX_ROOT`, with vectors under `vectors/`. This is **not** in PostgreSQL. It lives on the API's filesystem, so a lost volume means indexing again, and indexes are instance-wide rather than per board.

| Limit | Default | Override |
|---|---|---|
| Files per index | 5000 | `CODE_SEARCH_MAX_FILES`, up to 20000 per call |
| File size | 512 KiB | `CODE_SEARCH_MAX_FILE_SIZE`, up to 5 MiB per call |
| Allowed folders | The API's working directory and its parent, plus `REPOS_BASE_DIR` | `CODE_SEARCH_ALLOWED_ROOTS` |

Paths outside the allowed roots are rejected. Writes to one repo are serialized by an in-process lock.

**The index reads files the API can see.** In practice, this is the API's own container filesystem and any mounted repo folder, not an agent's clone in a runner.

## Everything is lexical

Set expectations accordingly. There is no language server, type checker or embedding model:

- **Symbols** come from regex and indentation, so some are missed. For example, JS methods whose parameter list spans several lines are not extracted today.
- **"Semantic" search uses hashed embeddings.** `createHashedEmbedding` hashes tokens, name parts and character trigrams into a 256-dimensional vector. It finds similar *spelling* and shared identifiers, not meaning, so `search_semantic` won't connect "authenticate" with "login" unless they share text.
- **References** are name occurrences resolved against imports, with a confidence level, instead of claiming certainty.

Imports are resolved for JavaScript, TypeScript and Python. Go, Rust, Java, C/C++ and Ruby get name-based references only.

## Reference graph

For each file, indexing stores:

- `imports`: ESM, CommonJS, `export ... from` and Python imports, with the names they bind.
- `references`: every identifier in code, flagged as call, member access or import. Comments and strings are masked first, while `${...}` expressions are kept. Plain references are stored as bare line numbers to save space.

At query time, `find_references` and `find_callers` resolve occurrences:

| Confidence | Meaning |
|---|---|
| `high` | Same file, or a name imported from the symbol's file |
| `medium` | Imported from an unresolved module with a matching last segment, or a method on another receiver |
| `low` | Shares only the name |

Files importing the same name from another module, or defining their own top-level symbol with it, are excluded. Indexes built before the graph existed return `graphAvailable: false`, and need `index_folder` again.

A typical refactor: `search_symbols`, then `find_references` with `minConfidence: "high"`, then edit, then `update_files`.

## Freshness

Indexes are snapshots, so search responses begin with a freshness report: `{ freshness, results }`.

- `stale` means an indexable file changed on disk. Files are compared by size and mtime and **confirmed by content hash**, so a touched but unchanged file is not stale. `stale: null` with an `error` means the scan failed.
- A moved git HEAD alone does not make an index stale, as only file contents affect results.
- Results are cached for 5 seconds so a burst of searches scans the repo once. `check_freshness` always rescans.

### Keeping an index current

| Tool | Use |
|---|---|
| `ensure_indexed(path)` | **The usual entry point.** Indexes if absent, syncs if stale, otherwise does nothing |
| `sync` | Incremental re-index. Unchanged files are skipped without reading |
| `update_files` | Re-index specific files |
| `index_folder` | Full index |

File edits made through the agent manager's own file tools are also pushed automatically: `scheduleCodeIndexUpdate` waits for 3 seconds of inactivity, then calls `update_files` on the matching repo. Git pulls and changes from other processes need `sync` or `ensure_indexed`.

## Reading code

- `get_symbol` returns a symbol's source, and with `verify: true` it detects drift against the indexed hash.
- `read_file_range` reads live lines of an **indexed** file, up to 2000 at a time, for what no symbol covers, such as imports and configuration. `driftDetected: true` means the file changed since indexing. Files not in the index are rejected.

Tools take either `repoId` or `repoName`. An unknown or ambiguous name is rejected with the candidates.

## Vector store fallback

`createVectorStore` tries ZVEC and falls back to memory if it can't start, unless `CODE_SEARCH_VECTOR_BACKEND=memory` selects memory outright. The memory store is rebuilt from `index.json` when needed. `vectorBackend` in the repo summary shows which one is active.
