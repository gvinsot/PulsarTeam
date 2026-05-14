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

## 4. MCP

### ALL `/api/code-index/mcp`
JSON-RPC MCP endpoint that exposes the same operations as tools, for agents to invoke directly.
