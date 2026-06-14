import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { X, GitCommit, Tag, ExternalLink, Loader2, AlertCircle, Clock, FolderOpen, File, ChevronRight, ChevronDown, GitBranch, ArrowLeft, FileText, RefreshCw, Network } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
import { useEscapeKey, useBodyScrollLock } from '../hooks/useDismiss';
import CallGraphTab from './CallGraphTab';

export default function GitHubActivityModal({ owner, repo, boardId, onClose }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('activity');

  // Build a sha → tags lookup so each commit can render its tags inline
  const tagsBySha = useMemo(() => {
    const map = new Map();
    if (!data?.tags) return map;
    for (const t of data.tags) {
      if (!t.sha) continue;
      const list = map.get(t.sha) || [];
      list.push(t);
      map.set(t.sha, list);
    }
    return map;
  }, [data]);

  // Tags whose commit is not in the visible (30-day) commit list — shown as a separate group below
  const orphanTags = useMemo(() => {
    if (!data?.tags || !data?.commits) return [];
    const commitShas = new Set(data.commits.map(c => c.sha));
    return data.tags.filter(t => !commitShas.has(t.sha));
  }, [data]);

  useEscapeKey(onClose);
  useBodyScrollLock();

  // Bump on each load so only the latest response updates state (guards against
  // a stale fetch landing after owner/repo/boardId changed or the modal closed).
  const reqIdRef = useRef(0);
  const loadActivity = useCallback((opts = {}) => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    return api.getGitHubActivity(owner, repo, boardId, opts)
      .then(result => { if (reqId === reqIdRef.current) setData(result); })
      .catch(err => { if (reqId === reqIdRef.current) setError(err.message); })
      .finally(() => { if (reqId === reqIdRef.current) setLoading(false); });
  }, [owner, repo, boardId]);

  useEffect(() => { loadActivity(); }, [loadActivity]);

  const formatDate = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours < 1) return 'just now';
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-dark-900 border border-dark-700 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{
          width: tab === 'callgraph' ? '1200px' : '800px',
          maxWidth: '95vw',
          maxHeight: '90vh',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-dark-700 shrink-0">
          <div className="flex items-center gap-2">
            <GithubIcon className="w-5 h-5 text-dark-100" />
            <h2 className="text-base font-semibold text-dark-100">{owner}/{repo}</h2>
            <span className="text-xs text-dark-400">Activity</span>
          </div>
          <div className="flex items-center gap-2">
            {tab === 'activity' && (
              <button
                onClick={() => loadActivity({ refresh: true })}
                disabled={loading}
                className="p-1.5 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Refresh activity"
              >
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              </button>
            )}
            <a
              href={`https://github.com/${owner}/${repo}`}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors"
              title="Open on GitHub"
            >
              <ExternalLink size={14} />
            </a>
            <button
              onClick={onClose}
              className="p-1.5 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-dark-700 shrink-0">
          <button
            onClick={() => setTab('activity')}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors ${
              tab === 'activity'
                ? 'text-dark-100 border-b-2 border-purple-500'
                : 'text-dark-400 hover:text-dark-100'
            }`}
          >
            <GitCommit size={14} />
            Commits &amp; Tags
            {data && (
              <span className="text-xs text-dark-500 ml-1">
                ({data.commits.length}
                {data.tags.length > 0 ? ` · ${data.tags.length} tag${data.tags.length > 1 ? 's' : ''}` : ''})
              </span>
            )}
          </button>
          <button
            onClick={() => setTab('explorer')}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors ${
              tab === 'explorer'
                ? 'text-dark-100 border-b-2 border-purple-500'
                : 'text-dark-400 hover:text-dark-100'
            }`}
          >
            <FolderOpen size={14} />
            Explorer
          </button>
          <button
            onClick={() => setTab('callgraph')}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors ${
              tab === 'callgraph'
                ? 'text-dark-100 border-b-2 border-purple-500'
                : 'text-dark-400 hover:text-dark-100'
            }`}
            title="UI ↔ backend call graph (on-demand analysis)"
          >
            <Network size={14} />
            Call Graph
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4" style={{ minHeight: 0 }}>
          {tab === 'activity' && loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="animate-spin text-purple-400" />
              <span className="ml-2 text-dark-400">Loading activity...</span>
            </div>
          )}

          {tab === 'activity' && error && (
            <div className="flex items-center gap-2 p-4 bg-red-500/10 border border-red-500/20 rounded-lg">
              <AlertCircle size={16} className="text-red-400" />
              <span className="text-sm text-red-400">{error}</span>
            </div>
          )}

          {data && !loading && tab === 'activity' && (
            <div className="space-y-1">
              {data.commits.length === 0 && data.tags.length === 0 ? (
                <p className="text-dark-500 text-sm text-center py-8">No commits in the last 30 days</p>
              ) : (
                <>
                  {data.commits.map(c => {
                    const commitTags = tagsBySha.get(c.sha) || [];
                    return (
                      <div
                        key={c.sha}
                        className="flex items-start gap-3 p-2.5 rounded-lg hover:bg-dark-800 transition-colors group"
                      >
                        {c.authorAvatar ? (
                          <img src={c.authorAvatar} alt="" className="w-6 h-6 rounded-full mt-0.5 shrink-0" />
                        ) : (
                          <div className="w-6 h-6 rounded-full bg-dark-700 flex items-center justify-center mt-0.5 shrink-0">
                            <GitCommit size={12} className="text-dark-400" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start gap-2 flex-wrap">
                            <a
                              href={c.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sm text-dark-100 truncate hover:text-purple-300 min-w-0 flex-1"
                              title={c.message}
                            >
                              {c.message}
                            </a>
                            {commitTags.map(t => (
                              <a
                                key={t.name}
                                href={t.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-green-500/10 border border-green-500/30 text-xs text-green-300 hover:bg-green-500/20 hover:text-green-200 transition-colors shrink-0"
                                title={`Tag / release: ${t.name}`}
                              >
                                <Tag size={10} />
                                {t.name}
                              </a>
                            ))}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <a
                              href={c.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-purple-400 font-mono hover:text-purple-300"
                            >
                              {c.shortSha}
                            </a>
                            <span className="text-xs text-dark-500">{c.author}</span>
                            <span className="text-xs text-dark-600 flex items-center gap-0.5">
                              <Clock size={10} />
                              {formatDate(c.date)}
                            </span>
                          </div>
                        </div>
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-dark-600 hover:text-dark-300 mt-1 shrink-0"
                          title="Open commit on GitHub"
                        >
                          <ExternalLink size={12} />
                        </a>
                      </div>
                    );
                  })}

                  {orphanTags.length > 0 && (
                    <div className="pt-3 mt-3 border-t border-dark-700">
                      <p className="text-xs text-dark-500 px-1 mb-1.5">
                        Older tags (commit outside the 30-day window)
                      </p>
                      {orphanTags.map(t => (
                        <a
                          key={t.name}
                          href={t.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-dark-800 transition-colors group"
                        >
                          <Tag size={14} className="text-green-400 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-dark-100 font-medium group-hover:text-green-300">{t.name}</p>
                            <code className="text-xs text-dark-500 font-mono">{t.shortSha}</code>
                          </div>
                          <ExternalLink size={12} className="text-dark-600 group-hover:text-dark-400 shrink-0" />
                        </a>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {tab === 'explorer' && (
            <RepoExplorer owner={owner} repo={repo} boardId={boardId} />
          )}

          {tab === 'callgraph' && (
            <div className="h-full min-h-[500px]" style={{ height: '70vh' }}>
              <CallGraphTab owner={owner} repo={repo} boardId={boardId} />
            </div>
          )}

          {tab === 'activity' && data?.fetchedAt && (
            <p className="text-xs text-dark-600 text-right mt-3">
              Fetched {formatDate(data.fetchedAt)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Repo Explorer sub-component ─────────────────────────────────────────── */

function RepoExplorer({ owner, repo, boardId }) {
  const [branches, setBranches] = useState([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [tree, setTree] = useState(null);
  const [loadingBranches, setLoadingBranches] = useState(true);
  const [loadingTree, setLoadingTree] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileContent, setFileContent] = useState(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState(new Set());
  const [error, setError] = useState(null);

  // Load branches on mount
  useEffect(() => {
    let cancelled = false;
    setLoadingBranches(true);
    api.getGitHubBranches(owner, repo, boardId)
      .then(data => {
        if (cancelled) return;
        setBranches(data);
        // Auto-select main/master or first branch
        const main = data.find(b => b.name === 'main') || data.find(b => b.name === 'master') || data[0];
        if (main) setSelectedBranch(main.name);
      })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoadingBranches(false); });
    return () => { cancelled = true; };
  }, [owner, repo, boardId]);

  // Load tree when branch changes
  useEffect(() => {
    if (!selectedBranch) return;
    let cancelled = false;
    setLoadingTree(true);
    setTree(null);
    setSelectedFile(null);
    setFileContent(null);
    setExpandedDirs(new Set());
    setError(null);
    api.getGitHubTree(owner, repo, selectedBranch, boardId)
      .then(data => { if (!cancelled) setTree(data); })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoadingTree(false); });
    return () => { cancelled = true; };
  }, [owner, repo, selectedBranch, boardId]);

  // Build nested tree structure from flat list
  const nestedTree = useMemo(() => {
    if (!tree?.tree) return [];
    return buildNestedTree(tree.tree);
  }, [tree]);

  const toggleDir = useCallback((path) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const openFile = useCallback((filePath) => {
    setSelectedFile(filePath);
    setFileContent(null);
    setLoadingFile(true);
    api.getGitHubFile(owner, repo, selectedBranch, filePath, boardId)
      .then(data => setFileContent(data))
      .catch(err => setFileContent({ error: err.message }))
      .finally(() => setLoadingFile(false));
  }, [owner, repo, selectedBranch, boardId]);

  const goBackToTree = useCallback(() => {
    setSelectedFile(null);
    setFileContent(null);
  }, []);

  const isMarkdown = selectedFile && /\.(md|mdx|markdown)$/i.test(selectedFile);

  if (loadingBranches) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={24} className="animate-spin text-purple-400" />
        <span className="ml-2 text-dark-400">Loading branches...</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Branch selector */}
      <div className="flex items-center gap-2">
        <GitBranch size={14} className="text-purple-400 shrink-0" />
        <select
          value={selectedBranch}
          onChange={e => setSelectedBranch(e.target.value)}
          className="bg-dark-800 border border-dark-600 text-dark-100 text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:border-purple-500 min-w-0 flex-1 max-w-xs"
        >
          {branches.map(b => (
            <option key={b.name} value={b.name}>{b.name}</option>
          ))}
        </select>
        {selectedFile && (
          <button
            onClick={goBackToTree}
            className="flex items-center gap-1 text-sm text-purple-400 hover:text-purple-300 transition-colors ml-auto"
          >
            <ArrowLeft size={14} />
            Back to files
          </button>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
          <AlertCircle size={14} className="text-red-400" />
          <span className="text-sm text-red-400">{error}</span>
        </div>
      )}

      {loadingTree && (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={20} className="animate-spin text-purple-400" />
          <span className="ml-2 text-dark-400 text-sm">Loading file tree...</span>
        </div>
      )}

      {/* File viewer */}
      {selectedFile && (
        <div className="space-y-2">
          {/* Breadcrumb */}
          <div className="flex items-center gap-1 text-xs text-dark-400 px-1 flex-wrap">
            <FileText size={12} className="text-purple-400 shrink-0" />
            {selectedFile.split('/').map((part, i, arr) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-dark-600">/</span>}
                <span className={i === arr.length - 1 ? 'text-dark-100 font-medium' : ''}>{part}</span>
              </span>
            ))}
            {fileContent?.htmlUrl && (
              <a
                href={fileContent.htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto text-dark-500 hover:text-dark-300 transition-colors"
                title="View on GitHub"
              >
                <ExternalLink size={12} />
              </a>
            )}
          </div>

          {loadingFile ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="animate-spin text-purple-400" />
              <span className="ml-2 text-dark-400 text-sm">Loading file...</span>
            </div>
          ) : fileContent?.error ? (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
              <AlertCircle size={14} className="text-red-400" />
              <span className="text-sm text-red-400">{fileContent.error}</span>
            </div>
          ) : fileContent?.isBinary ? (
            <div className="text-center py-8">
              <p className="text-dark-400 text-sm mb-2">Binary file — cannot display inline</p>
              {fileContent.downloadUrl && (
                <a
                  href={fileContent.downloadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-purple-400 hover:text-purple-300 text-sm underline"
                >
                  Download file
                </a>
              )}
            </div>
          ) : fileContent?.content != null ? (
            isMarkdown ? (
              <div className="bg-dark-800 border border-dark-700 rounded-lg p-4 overflow-x-auto">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  className="prose prose-invert prose-sm max-w-none break-words"
                  components={mdComponents}
                >
                  {fileContent.content}
                </ReactMarkdown>
              </div>
            ) : (
              <pre className="bg-dark-800 border border-dark-700 rounded-lg p-4 overflow-x-auto text-xs font-mono text-dark-200 leading-relaxed whitespace-pre">
                {fileContent.content}
              </pre>
            )
          ) : null}
        </div>
      )}

      {/* File tree */}
      {!selectedFile && tree && !loadingTree && (
        <div className="border border-dark-700 rounded-lg overflow-hidden">
          <FileTreeView
            nodes={nestedTree}
            expandedDirs={expandedDirs}
            toggleDir={toggleDir}
            openFile={openFile}
            depth={0}
          />
        </div>
      )}
    </div>
  );
}

/* ── Markdown components (dark theme) ────────────────────────────────────── */

const mdComponents = {
  pre: ({ children }) => <pre className="bg-dark-900 rounded-lg p-3 overflow-x-auto my-2 border border-dark-600">{children}</pre>,
  code: ({ children }) => !String(children).includes('\n')
    ? <code className="bg-dark-700 px-1.5 py-0.5 rounded text-purple-300 text-xs">{children}</code>
    : <code className="text-green-300 text-xs">{children}</code>,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline">{children}</a>,
  table: ({ children }) => <div className="overflow-x-auto my-2"><table className="border-collapse border border-dark-600 w-full text-xs">{children}</table></div>,
  th: ({ children }) => <th className="border border-dark-600 px-2 py-1 bg-dark-700 text-left">{children}</th>,
  td: ({ children }) => <td className="border border-dark-600 px-2 py-1">{children}</td>,
  ul: ({ children }) => <ul className="list-disc list-inside space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-inside space-y-1">{children}</ol>,
  h1: ({ children }) => <h1 className="text-lg font-bold text-dark-100 mt-4 mb-2 pb-1 border-b border-dark-700">{children}</h1>,
  h2: ({ children }) => <h2 className="text-base font-bold text-dark-100 mt-4 mb-2 pb-1 border-b border-dark-700">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-bold text-dark-100 mt-3 mb-1">{children}</h3>,
  h4: ({ children }) => <h4 className="text-sm font-semibold text-dark-200 mt-2 mb-1">{children}</h4>,
  blockquote: ({ children }) => <blockquote className="border-l-2 border-purple-500 pl-3 my-2 text-dark-400 italic">{children}</blockquote>,
  p: ({ children }) => <p className="my-1.5 leading-relaxed">{children}</p>,
  hr: () => <hr className="border-dark-600 my-3" />,
  li: ({ children }) => <li className="text-dark-200">{children}</li>,
  img: ({ src, alt }) => <img src={src} alt={alt || ''} className="max-w-full rounded-lg my-2" />,
};

/* ── File tree view component ────────────────────────────────────────────── */

function FileTreeView({ nodes, expandedDirs, toggleDir, openFile, depth }) {
  return (
    <div>
      {nodes.map(node => (
        <FileTreeNode
          key={node.path}
          node={node}
          expandedDirs={expandedDirs}
          toggleDir={toggleDir}
          openFile={openFile}
          depth={depth}
        />
      ))}
    </div>
  );
}

function FileTreeNode({ node, expandedDirs, toggleDir, openFile, depth }) {
  const isDir = node.type === 'tree';
  const isExpanded = expandedDirs.has(node.path);
  const paddingLeft = 12 + depth * 16;

  const ext = node.name.split('.').pop()?.toLowerCase();
  const iconColor = getFileIconColor(ext, isDir);

  return (
    <>
      <button
        className="w-full flex items-center gap-2 py-1.5 px-2 hover:bg-dark-800 transition-colors text-left group"
        style={{ paddingLeft: `${paddingLeft}px` }}
        onClick={() => isDir ? toggleDir(node.path) : openFile(node.path)}
      >
        {isDir ? (
          <>
            {isExpanded ? <ChevronDown size={12} className="text-dark-500 shrink-0" /> : <ChevronRight size={12} className="text-dark-500 shrink-0" />}
            <FolderOpen size={14} className={`shrink-0 ${iconColor}`} />
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            <File size={14} className={`shrink-0 ${iconColor}`} />
          </>
        )}
        <span className={`text-sm truncate ${isDir ? 'text-dark-100 font-medium' : 'text-dark-200 group-hover:text-dark-100'}`}>
          {node.name}
        </span>
        {!isDir && node.size > 0 && (
          <span className="text-xs text-dark-600 ml-auto shrink-0">{formatFileSize(node.size)}</span>
        )}
      </button>
      {isDir && isExpanded && node.children && (
        <FileTreeView
          nodes={node.children}
          expandedDirs={expandedDirs}
          toggleDir={toggleDir}
          openFile={openFile}
          depth={depth + 1}
        />
      )}
    </>
  );
}

/* ── Helper: build nested tree from flat GitHub tree ─────────────────────── */

function buildNestedTree(flatTree) {
  const root = [];
  const dirMap = new Map();

  // Sort: directories first, then alphabetical
  const sorted = [...flatTree].sort((a, b) => {
    if (a.type === 'tree' && b.type !== 'tree') return -1;
    if (a.type !== 'tree' && b.type === 'tree') return 1;
    return a.path.localeCompare(b.path);
  });

  for (const item of sorted) {
    const parts = item.path.split('/');
    const name = parts[parts.length - 1];
    const node = { ...item, name, children: item.type === 'tree' ? [] : undefined };

    if (parts.length === 1) {
      root.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join('/');
      const parent = dirMap.get(parentPath);
      if (parent) {
        parent.children.push(node);
      } else {
        root.push(node);
      }
    }

    if (item.type === 'tree') {
      dirMap.set(item.path, node);
    }
  }

  // Sort each directory's children: dirs first, then files, alphabetical
  const sortChildren = (nodes) => {
    nodes.sort((a, b) => {
      if (a.type === 'tree' && b.type !== 'tree') return -1;
      if (a.type !== 'tree' && b.type === 'tree') return 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.children) sortChildren(n.children);
    }
  };
  sortChildren(root);

  return root;
}

/* ── Helper: file size formatting ────────────────────────────────────────── */

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ── Helper: file icon colors by extension ───────────────────────────────── */

function getFileIconColor(ext, isDir) {
  if (isDir) return 'text-blue-400';
  const colors = {
    js: 'text-yellow-400', jsx: 'text-yellow-400', ts: 'text-blue-400', tsx: 'text-blue-400',
    json: 'text-yellow-300', md: 'text-purple-400', mdx: 'text-purple-400',
    css: 'text-blue-300', scss: 'text-pink-400', html: 'text-orange-400',
    py: 'text-green-400', go: 'text-cyan-400', rs: 'text-orange-300',
    yml: 'text-red-300', yaml: 'text-red-300', toml: 'text-red-300',
    sh: 'text-green-300', bash: 'text-green-300',
    dockerfile: 'text-blue-300', docker: 'text-blue-300',
    svg: 'text-orange-300', png: 'text-green-300', jpg: 'text-green-300',
    lock: 'text-dark-500', gitignore: 'text-dark-500',
  };
  return colors[ext] || 'text-dark-300';
}

/* ── GitHub icon ─────────────────────────────────────────────────────────── */

function GithubIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
    </svg>
  );
}
