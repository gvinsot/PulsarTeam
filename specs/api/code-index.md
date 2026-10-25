# Code Index — `/api/code-index/*`

Source: `api/src/routes/codeIndex.ts`. All routes require JWT.

The code-index service crawls a repository, extracts symbols, builds an embedding store, and exposes search endpoints over HTTP and over MCP (`ALL /api/code-index/mcp`).

---

## 1. Indexing

### POST `/api/code-index/index-folder`
Index a folder on disk (must be readable by the API process).
- **Body**: `{ path, repoName }`.
- **Response 200**: `{ filesIndexed, symbols, repoId, ... }`.

### POST `/api/code-index/index-project`
Trigger a background index pass on a project's source folder. The folder is looked up in `REPOS_BASE_DIR/<project>` and validated against an allow-list to prevent path traversal.
- **Body**: `{ projectName }`.
- **Response 202**: fire-and-forget.

### POST `/api/code-index/repos/:repoId/update-files`
Incremental re-index, capped at 100 files per call.
- **Body**: `{ files: [{ path, content? }] }` — when `content` is omitted, the file is re-read from disk.

### DELETE `/api/code-index/repos/:repoId`
Invalidate/delete the repository's index.

---

## 2. Browsing

### GET `/api/code-index/repos`
List indexed repos.

### GET `/api/code-index/repos/:repoId`
Repo summary (file count, symbol count, etc.).

### GET `/api/code-index/repos/:repoId/file-tree`
Hierarchical file tree.

### GET `/api/code-index/repos/:repoId/file-outline`
Symbol outline for a file.
- **Query**: `filePath`.

### GET `/api/code-index/repos/:repoId/symbol`
Fetch a single symbol by ID.
- **Query**: `symbolId`, `verify?` (boolean), `contextLines?`.

---

## 3. Search

### GET `/api/code-index/repos/:repoId/search-symbols`
Symbol-name search.
- **Query**: `query`, `topK?`, `kind?: 'function'|'class'|'method'`.

### GET `/api/code-index/repos/:repoId/search-semantic`
Embedding-based semantic search.
- **Query**: `query`, `topK?`.

### GET `/api/code-index/repos/:repoId/search-text`
Plain text/regex search.
- **Query**: `query`, `topK?`.

---

## 4. References (call/import graph)

Built at indexing time: every file stores its imports and identifier occurrences (calls, imports, member accesses). Queries resolve them against the target symbol and rank each hit by confidence (`high` = resolved through an import or the same file/class, `medium` = probable, `low` = shares the name only). `graphAvailable: false` means the index predates the graph — re-index.

### GET `/api/code-index/repos/:repoId/references`
Every reference to a symbol.
- **Query**: `symbolId`, `limit?` (1-1000, default 100), `minConfidence?: 'high'|'medium'|'low'`, `includeImports?` (boolean, default true).
- **Response 200**: `{ symbol, graphAvailable, total, truncated, references: [{ filePath, line, kind: 'call'|'import'|'reference', confidence, receiver?, enclosingSymbol, preview }] }`.

### GET `/api/code-index/repos/:repoId/callers`
The symbols calling a function/method/class constructor.
- **Query**: `symbolId`, `limit?`, `minConfidence?`.
- **Response 200**: `{ symbol, graphAvailable, totalCalls, total, truncated, callers: [{ caller: { id, qualifiedName, kind, filePath, startLine } | null, filePath, lines, confidence }] }` — `caller: null` groups module-level calls of a file.

---

## 5. MCP

### ALL `/api/code-index/mcp`
JSON-RPC MCP endpoint that exposes the same operations as tools, for agents to invoke directly (including `find_references` and `find_callers`). Tool reference: `api/src/services/codeSearch/README.md`.
