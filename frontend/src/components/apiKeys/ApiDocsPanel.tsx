import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  RefreshCw,
  Search,
} from 'lucide-react';
import { api } from '../../api';
import type { ApiKeyScope, McpToolDoc, OpenApiDocument } from '../../types';
import CopyableCode from './CopyableCode';
import SchemaFieldsTable from './SchemaFieldsTable';
import {
  curlFor,
  firstExample,
  mcpSetupCommands,
  operationAnchor,
  operationsByTag,
  resolveResponse,
  resolveSchema,
  toolCallBody,
  withServer,
  type DocOperation,
} from './apiDocsModel';

const markdownPlugins = [remarkGfm];

/** Section anchors the Keys tab can deep-link to. */
export type ApiDocsSection = 'overview' | 'quickstart' | 'Insert' | 'MCP' | 'errors' | 'Legacy';

interface ApiDocsPanelProps {
  /** Scroll to this section once the document is loaded. */
  focus?: ApiDocsSection | null;
  /** Clear text is available only for keys minted in this open modal. */
  freshKeys?: Partial<Record<ApiKeyScope, string>>;
}

const METHOD_STYLE: Record<string, string> = {
  get: 'text-emerald-300 bg-emerald-500/10 ring-emerald-500/30',
  post: 'text-amber-300 bg-amber-500/10 ring-amber-500/30',
  put: 'text-sky-300 bg-sky-500/10 ring-sky-500/30',
  delete: 'text-rose-300 bg-rose-500/10 ring-rose-500/30',
};

const SCOPE_STYLE: Record<string, string> = {
  insert: 'text-sky-300 bg-sky-500/10',
  management: 'text-indigo-300 bg-indigo-500/10',
  admin: 'text-fuchsia-300 bg-fuchsia-500/10',
  legacy: 'text-amber-300 bg-amber-500/10',
};

function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown-content text-xs text-dark-300 leading-relaxed">
      <ReactMarkdown remarkPlugins={markdownPlugins}>{children}</ReactMarkdown>
    </div>
  );
}

function SectionTitle({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3 id={`api-docs-${id}`} className="text-sm font-semibold text-dark-100 scroll-mt-4">
      {children}
    </h3>
  );
}

function MethodBadge({ method }: { method: string }) {
  return (
    <span
      className={`inline-block min-w-[3.25rem] text-center px-1.5 py-0.5 rounded text-[10px] font-bold font-mono uppercase ring-1 ${METHOD_STYLE[method] || ''}`}
    >
      {method}
    </span>
  );
}

function ScopeBadge({ scope }: { scope?: string }) {
  if (!scope) return null;
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${SCOPE_STYLE[scope] || ''}`}>
      {scope} key
    </span>
  );
}

/** One MCP tool: description, arguments, and a ready tools/call request. */
function ToolEntry({
  doc,
  entry,
  tool,
  origin,
  apiKey,
}: {
  doc: OpenApiDocument;
  entry: DocOperation;
  tool: McpToolDoc;
  origin: string;
  apiKey?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border border-dark-700 rounded-lg">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-dark-800/60 rounded-lg"
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 mt-0.5 text-dark-400 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 mt-0.5 text-dark-400 shrink-0" />
        )}
        <code className="font-mono text-xs text-dark-100 shrink-0">{tool.name}</code>
        <span className="text-xs text-dark-400 line-clamp-1">{tool.description}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-3">
          <p className="text-xs text-dark-300">{tool.description}</p>
          <SchemaFieldsTable doc={doc} schema={tool.inputSchema} emptyLabel="No arguments." />
          <CopyableCode
            label="tools/call"
            code={curlFor(origin, entry, toolCallBody(doc, tool), apiKey)}
          />
        </div>
      )}
    </li>
  );
}

/** The catalogue of an MCP surface, filterable once it grows. */
function ToolCatalogue({
  doc,
  entry,
  origin,
  freshKey,
}: {
  doc: OpenApiDocument;
  entry: DocOperation;
  origin: string;
  freshKey?: string;
}) {
  const tools = useMemo(() => entry.op['x-mcp-tools'] || [], [entry]);
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter(
      t => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
    );
  }, [tools, query]);

  const scope = entry.op['x-api-key-scope'] || 'api';
  const [pastedKey, setPastedKey] = useState('');
  const key = pastedKey.trim() || freshKey;
  const commands = mcpSetupCommands(origin, entry, key);
  const clientConfig = JSON.stringify(
    {
      mcpServers: {
        [`pulsar-${scope}`]: {
          type: 'http',
          url: `${origin}${entry.path}`,
          headers: { Authorization: `Bearer ${key || `<${scope}-key>`}` },
        },
      },
    },
    null,
    2
  );

  return (
    <div className="space-y-3">
      <h5 className="text-xs font-medium text-dark-200">Connect Codex or Claude Code</h5>
      <p className="text-xs text-dark-400">
        {freshKey
          ? `Your newly created ${scope} key is included below.`
          : `Paste your saved ${scope} key below, or create one in the Keys tab. Existing keys cannot be retrieved in full.`}
      </p>
      {scope === 'insert' && (
        <p className="text-xs text-dark-400">
          Use an insert key bound to the board you want to create tasks on.
        </p>
      )}
      <label className="block space-y-1 text-xs text-dark-300">
        <span>{scope} key for these commands</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={pastedKey}
          onChange={e => setPastedKey(e.target.value)}
          placeholder={freshKey ? 'Using the newly created key' : `Paste your ${scope} key`}
          className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-dark-200 focus:outline-none focus:border-indigo-500"
        />
      </label>
      {!key && (
        <p className="text-xs text-amber-300">
          Replace &lt;{scope}-key&gt; with your {scope} key before running these commands.
        </p>
      )}
      <CopyableCode
        label={commands.envVar ? 'Codex CLI — bash / zsh' : 'Codex — ~/.codex/config.toml'}
        code={commands.codex}
      />
      <p className="text-xs text-dark-400">
        {commands.envVar ? (
          <>
            Start Codex from this terminal. Keep <code>{commands.envVar}</code> exported in every
            terminal where you launch Codex; the server configuration stores the variable name.
          </>
        ) : (
          <>
            Replace the existing <code>mcp_servers.pulsar-admin</code> section in{' '}
            <code>~/.codex/config.toml</code> with this configuration, or add it if absent. Restart
            Codex after saving. Update this section whenever you rotate your admin key.
          </>
        )}
      </p>
      <CopyableCode label="Claude Code — bash / zsh" code={commands.claude} />
      <p className="text-xs text-dark-400">
        Claude Code saves this connection in your user configuration, available across projects.
        Restart the client after adding the server.
      </p>
      <p className="text-xs text-dark-400">
        CLI documentation:{' '}
        <a
          className="text-indigo-300 hover:underline"
          href="https://developers.openai.com/codex/mcp"
          target="_blank"
          rel="noreferrer"
        >
          Codex
        </a>
        {' · '}
        <a
          className="text-indigo-300 hover:underline"
          href="https://code.claude.com/docs/en/mcp"
          target="_blank"
          rel="noreferrer"
        >
          Claude Code
        </a>
      </p>
      <CopyableCode label="MCP client config (Claude, Cursor…)" code={clientConfig} />
      <div className="flex items-center justify-between gap-3">
        <h5 className="text-xs font-medium text-dark-300">
          {tools.length} tool{tools.length === 1 ? '' : 's'}
        </h5>
        {tools.length > 6 && (
          <label className="flex items-center gap-1.5 bg-dark-900 border border-dark-700 rounded-lg px-2 py-1">
            <Search className="w-3 h-3 text-dark-500" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Filter tools"
              className="bg-transparent text-xs text-dark-200 placeholder-dark-500 focus:outline-none w-32"
            />
          </label>
        )}
      </div>
      <ul className="space-y-1.5">
        {shown.map(tool => (
          <ToolEntry
            key={tool.name}
            doc={doc}
            entry={entry}
            tool={tool}
            origin={origin}
            apiKey={key}
          />
        ))}
      </ul>
    </div>
  );
}

/** One endpoint: what it does, what it takes, what it answers. */
function OperationCard({
  doc,
  entry,
  origin,
  defaultOpen,
  freshKey,
}: {
  doc: OpenApiDocument;
  entry: DocOperation;
  origin: string;
  defaultOpen: boolean;
  freshKey?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { op, path, method } = entry;
  const isMcp = !!op['x-mcp-tools'];
  const bodySchema = op.requestBody?.content['application/json']?.schema;
  const examples = op.requestBody?.content['application/json']?.examples || {};
  const exampleKeys = Object.keys(examples);
  const [exampleKey, setExampleKey] = useState(exampleKeys[exampleKeys.length - 1]);

  return (
    <div
      id={operationAnchor(op)}
      className={`border rounded-xl scroll-mt-4 ${op.deprecated ? 'border-dark-700/60 opacity-90' : 'border-dark-700'}`}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-dark-800/50 rounded-xl flex-wrap"
      >
        {open ? (
          <ChevronDown className="w-4 h-4 text-dark-400 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-dark-400 shrink-0" />
        )}
        <MethodBadge method={method} />
        <code
          className={`font-mono text-xs ${op.deprecated ? 'line-through text-dark-400' : 'text-dark-100'}`}
        >
          {path}
        </code>
        <ScopeBadge scope={op['x-api-key-scope']} />
        <span className="text-xs text-dark-400 sm:ml-auto">{op.summary}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 space-y-4 border-t border-dark-700/60">
          {op.description && <Markdown>{op.description}</Markdown>}

          {op.parameters && op.parameters.length > 0 && (
            <div className="space-y-1.5">
              <h4 className="text-xs font-medium text-dark-300">Parameters</h4>
              <ul className="space-y-1 text-xs">
                {op.parameters.map(p => (
                  <li key={`${p.in}-${p.name}`} className="flex gap-2 flex-wrap">
                    <code className="font-mono text-dark-100">{p.name}</code>
                    <span className="text-dark-500">in {p.in}</span>
                    {p.required && <span className="text-[10px] text-rose-300">required</span>}
                    {p.schema?.enum && (
                      <code className="font-mono text-indigo-300">
                        {p.schema.enum.map(v => JSON.stringify(v)).join(' | ')}
                      </code>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {bodySchema && !isMcp && (
            <div className="space-y-1.5">
              <h4 className="text-xs font-medium text-dark-300">Request body</h4>
              <SchemaFieldsTable doc={doc} schema={bodySchema} />
            </div>
          )}

          {(method === 'get' || exampleKeys.length > 0) && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <h4 className="text-xs font-medium text-dark-300">Example</h4>
                {exampleKeys.length > 1 &&
                  exampleKeys.map(key => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setExampleKey(key)}
                      className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                        key === exampleKey
                          ? 'bg-dark-700 text-dark-100'
                          : 'text-dark-400 hover:text-dark-200'
                      }`}
                    >
                      {examples[key].summary || key}
                    </button>
                  ))}
              </div>
              <CopyableCode code={curlFor(origin, entry, firstExample(op, exampleKey), freshKey)} />
            </div>
          )}

          <div className="space-y-1.5">
            <h4 className="text-xs font-medium text-dark-300">Responses</h4>
            <ul className="space-y-1">
              {Object.entries(op.responses).map(([code, raw]) => {
                const response = resolveResponse(doc, raw);
                const schema = resolveSchema(doc, response.content?.['application/json']?.schema);
                const taskRef = JSON.stringify(schema || {}).includes('#/components/schemas/Task"');
                return (
                  <li key={code} className="flex items-start gap-2 text-xs">
                    <code
                      className={`font-mono shrink-0 w-9 ${
                        code.startsWith('2')
                          ? 'text-emerald-300'
                          : code.startsWith('4')
                            ? 'text-amber-300'
                            : 'text-rose-300'
                      }`}
                    >
                      {code}
                    </code>
                    <div className="text-dark-300 min-w-0">
                      <Markdown>{response.description || ''}</Markdown>
                      {taskRef && (
                        <a
                          href="#api-docs-task"
                          onClick={e => {
                            e.preventDefault();
                            document.getElementById('api-docs-task')?.scrollIntoView({
                              behavior: 'smooth',
                            });
                          }}
                          className="text-indigo-300 hover:underline"
                        >
                          Task object ↓
                        </a>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          {isMcp && <ToolCatalogue doc={doc} entry={entry} origin={origin} freshKey={freshKey} />}
        </div>
      )}
    </div>
  );
}

/**
 * The API reference, rendered from the OpenAPI document the server generates
 * from its own schemas and MCP servers (api/src/services/apiDocs.ts). Every
 * endpoint, field and tool shown here is one the server actually serves.
 */
export default function ApiDocsPanel({ focus, freshKeys = {} }: ApiDocsPanelProps) {
  const [doc, setDoc] = useState<OpenApiDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const origin = window.location.origin;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDoc(await api.getApiDocs());
    } catch {
      setError('The API documentation could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!doc || !focus) return;
    // After the render that mounted the sections.
    const id = requestAnimationFrame(() =>
      document.getElementById(`api-docs-${focus}`)?.scrollIntoView({ behavior: 'smooth' })
    );
    return () => cancelAnimationFrame(id);
  }, [doc, focus]);

  const groups = useMemo(() => (doc ? operationsByTag(doc) : []), [doc]);

  const download = () => {
    if (!doc) return;
    const blob = new Blob([JSON.stringify(withServer(doc, origin), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pulsarteam-openapi.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const scrollTo = (section: ApiDocsSection) =>
    document.getElementById(`api-docs-${section}`)?.scrollIntoView({ behavior: 'smooth' });

  if (loading) {
    return <div className="py-10 text-center text-sm text-dark-400">Loading documentation…</div>;
  }
  if (error || !doc) {
    return (
      <div className="py-10 flex flex-col items-center gap-3 text-sm text-dark-400">
        <span className="flex items-center gap-2 text-amber-300">
          <AlertTriangle className="w-4 h-4" />
          {error}
        </span>
        <button
          type="button"
          onClick={load}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-dark-700 hover:bg-dark-600 text-dark-200 rounded-lg text-xs"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Retry
        </button>
      </div>
    );
  }

  const insertOps = groups.find(g => g.tag === 'Insert')?.ops || [];
  const getBoardOp = insertOps.find(o => o.method === 'get');
  const createOp = insertOps.find(o => o.method === 'post');
  const taskSchema = doc.components.schemas?.Task;
  const tagDescription = (tag: string) => doc.tags?.find(t => t.name === tag)?.description;

  const nav: { id: ApiDocsSection; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'quickstart', label: 'Quick start' },
    ...groups.map(g => ({ id: g.tag as ApiDocsSection, label: g.tag })),
    { id: 'errors', label: 'Errors' },
  ];

  return (
    <div className="space-y-6">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-dark-100">{doc.info.title}</h2>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-dark-700 text-dark-300">
              v{doc.info.version}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-dark-700 text-dark-300">
              OpenAPI {doc.openapi}
            </span>
          </div>
          <p className="text-xs text-dark-500 mt-1">
            Base URL <code className="text-dark-300">{origin}</code> · generated from the running
            server
          </p>
        </div>
        <button
          type="button"
          onClick={download}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-dark-700 hover:bg-dark-600 text-dark-200 rounded-lg text-xs transition-colors"
        >
          <Download className="w-3.5 h-3.5" />
          openapi.json
        </button>
      </div>

      <nav className="flex flex-wrap gap-1.5 sticky top-0 z-10 -mx-1 px-1 py-1.5 bg-dark-900/95 backdrop-blur">
        {nav.map(item => (
          <button
            key={item.id}
            type="button"
            onClick={() => scrollTo(item.id)}
            className="px-2.5 py-1 rounded-full text-xs text-dark-300 bg-dark-800 hover:bg-dark-700 hover:text-dark-100 transition-colors"
          >
            {item.label}
          </button>
        ))}
      </nav>

      {/* ── Overview ─────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <SectionTitle id="overview">Overview</SectionTitle>
        {doc.info.description && <Markdown>{doc.info.description}</Markdown>}
        {doc.components.securitySchemes && (
          <ul className="space-y-1 text-xs">
            {Object.entries(doc.components.securitySchemes).map(([name, scheme]) => (
              <li key={name} className="flex gap-2">
                <code className="font-mono text-dark-200 shrink-0">{name}</code>
                <span className="text-dark-400">{scheme.description}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Quick start ──────────────────────────────────────────────────── */}
      {getBoardOp && createOp && (
        <section className="space-y-3">
          <SectionTitle id="quickstart">Quick start — insert a task</SectionTitle>
          <ol className="space-y-3 text-xs text-dark-300 list-decimal pl-5">
            <li>
              Create an <strong>insert key</strong> for your board in the <em>Keys</em> tab and keep
              it secret — it is shown once.
            </li>
            <li className="space-y-1.5">
              <span>List the board columns (optional — to choose a starting column):</span>
              <CopyableCode code={curlFor(origin, getBoardOp)} />
            </li>
            <li className="space-y-1.5">
              <span>Create the task:</span>
              <CopyableCode code={curlFor(origin, createOp, firstExample(createOp.op, 'full'))} />
            </li>
          </ol>
        </section>
      )}

      {/* ── Endpoints, by tag ───────────────────────────────────────────── */}
      {groups.map(group => (
        <section key={group.tag} className="space-y-2">
          <SectionTitle id={group.tag}>
            {group.tag === 'MCP' ? 'MCP surfaces' : `${group.tag} API`}
          </SectionTitle>
          {tagDescription(group.tag) && (
            <p className="text-xs text-dark-400">{tagDescription(group.tag)}</p>
          )}
          <div className="space-y-2">
            {group.ops.map(entry => (
              <OperationCard
                freshKey={
                  entry.op['x-api-key-scope'] === 'insert' ||
                  entry.op['x-api-key-scope'] === 'management' ||
                  entry.op['x-api-key-scope'] === 'admin'
                    ? freshKeys[entry.op['x-api-key-scope']]
                    : undefined
                }
                key={entry.op.operationId}
                doc={doc}
                entry={entry}
                origin={origin}
                defaultOpen={group.tag === 'Insert'}
              />
            ))}
          </div>
        </section>
      ))}

      {/* ── Errors ───────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <SectionTitle id="errors">Errors</SectionTitle>
        <p className="text-xs text-dark-400">
          Every error body is JSON with an <code className="text-dark-300">error</code> string. MCP
          tool failures are not HTTP errors: the JSON-RPC result carries{' '}
          <code className="text-dark-300">isError: true</code> and the same{' '}
          <code className="text-dark-300">{'{ "error": "…" }'}</code> text. A resource outside your
          scope answers “not found”, exactly like one that does not exist.
        </p>
        <ul className="space-y-1 text-xs">
          {Object.entries(doc.components.responses || {}).map(([name, response]) => (
            <li key={name} className="flex gap-2">
              <code className="font-mono text-dark-200 shrink-0 w-32">{name}</code>
              <span className="text-dark-400">{response.description}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* ── Task object ──────────────────────────────────────────────────── */}
      {taskSchema && (
        <section className="space-y-2">
          <SectionTitle id="task">Task object</SectionTitle>
          {taskSchema.description && (
            <p className="text-xs text-dark-400">{taskSchema.description}</p>
          )}
          <SchemaFieldsTable doc={doc} schema={taskSchema} />
        </section>
      )}
    </div>
  );
}
