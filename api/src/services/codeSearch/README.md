# Code Index MCP

Built-in MCP server (`ALL /api/code-index/mcp`, defined in `../codeIndexMcp.ts`) backed by
`CodeIndexService` (`../codeIndexService.ts`). It indexes a source folder into
`.data/code-index/<repoId>/index.json` and answers symbol, search and reference queries on it.

| Module                  | Role                                                              |
| ----------------------- | ----------------------------------------------------------------- |
| `symbolExtractor.ts`    | Classes, functions and methods per file (regex/indent based)      |
| `referenceExtractor.ts` | Imports and identifier occurrences per file — the reference graph |
| `embedding.ts`          | Hashed embeddings for semantic search                             |
| `vectorStore.ts`        | ZVEC vector store with an in-memory fallback                      |

## Tools

| Tool               | Arguments                                                           | Purpose                                             |
| ------------------ | ------------------------------------------------------------------- | --------------------------------------------------- |
| `index_folder`     | `path`, `repoName?`, `maxFiles?`, `maxFileSize?`                    | Index a folder (symbols, vectors, reference graph)  |
| `index_workspace`  | `subpath?`, `repoName?`, `maxFiles?`, `maxFileSize?`                | Index the backend workspace or a subpath            |
| `list_repos`       | —                                                                   | Indexed repos and their `repoId`                    |
| `get_repo_summary` | `repoId`                                                            | Counts by kind/language, skipped files              |
| `get_file_tree`    | `repoId`                                                            | Indexed file tree                                   |
| `get_file_outline` | `repoId`, `filePath`                                                | Symbols of one file                                 |
| `get_symbol`       | `repoId`, `symbolId`, `verify?`, `contextLines?`                    | Source + metadata of a symbol, optional drift check |
| `read_file_range`  | `repoId`, `filePath`, `startLine`, `endLine?`                       | Lines of an indexed file, always drift-checked      |
| `search_symbols`   | `repoId`, `query`, `kind?`, `topK?`                                 | Lexical search on names/signatures/summaries        |
| `search_semantic`  | `repoId`, `query`, `topK?`                                          | Embedding search                                    |
| `search_text`      | `repoId`, `query`, `topK?`                                          | Exact text search in symbol bodies                  |
| `find_references`  | `repoId`, `symbolId`, `limit?`, `minConfidence?`, `includeImports?` | Every place referencing a symbol                    |
| `find_callers`     | `repoId`, `symbolId`, `limit?`, `minConfidence?`                    | The symbols calling a function/method/constructor   |
| `update_files`     | `repoId`, `files[{ path, content? }]`                               | Incremental re-index (symbols, vectors and graph)   |
| `delete_repo`      | `repoId`                                                            | Drop an index                                       |

Symbol IDs look like `src/auth.js::AuthService.login#method`; get them from
`get_file_outline` or the `search_*` tools.

## Reading file ranges

`read_file_range` reads lines `startLine`–`endLine` (1-based, inclusive) of a file **present in
the index** — imports, config, module-level code that no symbol covers — without falling back to
raw file tools. The content is read live from disk and its hash compared with the file's
indexed `contentHash`, like `get_symbol` with `verify: true`: `driftDetected: true` means the
file changed since indexing (run `update_files` on it). The result also lists the indexed
`symbols` overlapping the range, with their `symbolId` for `get_symbol`.

- `endLine` defaults to `startLine + 199`; a range may span at most 2000 lines.
- An `endLine` past the end of the file is clamped (`endLineClamped: true`); a `startLine`
  past it, `startLine < 1` or `endLine < startLine` is an error.
- Files not in the index (unsupported extension, too large, outside the repo) and indexed
  files deleted from disk are rejected with a message pointing to `get_file_tree` / `update_files`.

## References and callers

**Typical refactor flow:** `search_symbols` → pick the `symbolId` → `find_references`
(with `minConfidence: "high"` for the certain hits first) → edit → `update_files`.
`find_callers` returns a `symbolId` per caller, so calling it again walks the call graph upwards.

### How the graph is built

At indexing (`index_folder`, `index_workspace`, `update_files`) each file stores, next to its
symbols:

- `imports` — ESM `import`, `export … from` re-exports, CommonJS `require`, Python
  `import` / `from … import`, with the local names they bind (aliases included);
- `references` — every identifier occurrence in code (comments and strings are masked first,
  template-literal `${…}` expressions are kept), keyed by name, flagged as call / member access /
  import, with the receiver of member accesses (`this.save()` → receiver `this`).

At query time the occurrences of the symbol's name (and of its import aliases) are resolved:

| Confidence | When                                                                                                                                                                                                                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `high`     | Same file; a name imported from the symbol's file (relative JS/TS specifiers with extension, `index` and `.js`→`.ts` fallbacks; Python relative/absolute modules, packages, re-exports through barrels/`__init__`); `ns.name` via a namespace import; a method called on `this`/`self` inside its class or on the class name |
| `medium`   | A name imported from an unresolved module whose last segment matches the symbol's file (path aliases); a method called on another receiver when no other symbol shares its name; same-name uses in languages without import tracking (Go, Rust, Java, C/C++, Ruby)                                                           |
| `low`      | Shares the name only (globals, subclasses, other receivers of a common method name)                                                                                                                                                                                                                                          |

Files that import the same name from another module, or define their own top-level symbol
with that name, are excluded. Each hit has `filePath`, `line`, `kind`
(`call` / `import` / `reference`), `confidence`, the innermost `enclosingSymbol` and a
`preview` of the line read live from disk.

### Limits

- Lexical, not type-based: `obj.method()` on an untyped receiver cannot be tied to a class,
  hence `medium`/`low` confidence for such calls.
- Only symbols the extractor finds can be targets or enclosing callers (e.g. JS methods whose
  parameter list spans several lines are not extracted today).
- Indexes created before the graph existed return `graphAvailable: false`; re-run
  `index_folder` to build it.
