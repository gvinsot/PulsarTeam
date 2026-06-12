/**
 * Code-graph analyzer.
 *
 * Builds two directed graphs from a repository's source files:
 *   - "ui-to-service"      : UI features (React components / pages) → API client → backend routes / services
 *   - "service-to-ui"      : Backend services / routes → API endpoints → UI features that call them
 *
 * The analysis is purely heuristic and regex-based — fast enough to run on
 * demand against a downloaded GitHub tree without any local clone.
 *
 * Optionally a configured LLM can post-process the raw graph to drop noise
 * and produce a more readable summary (clusters, edge labels, etc).
 */

import { getLlmConfig } from './database.js';
import { createProvider } from './llmProviders.js';

// ── Heuristics ──────────────────────────────────────────────────────────────

const UI_DIRS = ['frontend/', 'client/', 'web/', 'ui/', 'app/'];
const SERVICE_DIRS = ['api/', 'server/', 'backend/', 'runner-service/', 'services/'];

const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py'];

// Limits to keep network & memory bounded.
const MAX_FILES_PER_LAYER = 120;
const MAX_FILE_BYTES = 200_000;
const FETCH_FILE_TIMEOUT_MS = 15_000;
const LLM_REFINE_TIMEOUT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface GraphNode {
  id: string;
  label: string;
  layer: 'ui' | 'api-client' | 'route' | 'service';
  file?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}

export interface CodeGraph {
  direction: 'ui-to-service' | 'service-to-ui';
  nodes: GraphNode[];
  edges: GraphEdge[];
  mermaid: string;
  stats: {
    filesScanned: number;
    uiFiles: number;
    serviceFiles: number;
    truncated: boolean;
  };
  llm?: { model: string; provider: string } | null;
}

type FileMeta = { path: string; type: string; size: number };

// ── Public entrypoint ───────────────────────────────────────────────────────

interface AnalyzeOptions {
  owner: string;
  repo: string;
  ref: string;
  direction: 'ui-to-service' | 'service-to-ui';
  treeFiles: FileMeta[];
  truncated: boolean;
  fetchFile: (path: string) => Promise<string | null>;
  llmConfigId?: string | null;
}

export async function analyzeRepoCallGraph(opts: AnalyzeOptions): Promise<CodeGraph> {
  const { direction, treeFiles, truncated, fetchFile, llmConfigId } = opts;

  const allSources = treeFiles.filter(f => f.type === 'blob' && isSourceFile(f.path));

  const uiCandidates = allSources
    .filter(f => looksLikeUi(f.path))
    .slice(0, MAX_FILES_PER_LAYER);

  const serviceCandidates = allSources
    .filter(f => looksLikeService(f.path))
    .slice(0, MAX_FILES_PER_LAYER);

  // Download contents in parallel with a small concurrency cap.
  const uiContents = await downloadBatch(uiCandidates, fetchFile);
  const serviceContents = await downloadBatch(serviceCandidates, fetchFile);

  const apiClientCalls = extractApiClientCalls(uiContents);
  const routes = extractRoutes(serviceContents);

  // Map api-client method names → backend routes by name similarity.
  const linked = linkClientToRoute(apiClientCalls, routes);

  const graph = buildGraph(direction, apiClientCalls, routes, linked, {
    filesScanned: uiContents.length + serviceContents.length,
    uiFiles: uiContents.length,
    serviceFiles: serviceContents.length,
    truncated,
  });

  if (llmConfigId) {
    const refined = await refineWithLlm(graph, llmConfigId).catch(err => {
      console.warn('[CodeGraph] LLM refinement failed:', err.message);
      return null;
    });
    if (refined) {
      graph.nodes = refined.nodes;
      graph.edges = refined.edges;
      graph.mermaid = toMermaid(direction, refined.nodes, refined.edges);
      graph.llm = refined.llm;
    }
  }

  return graph;
}

// ── File classification helpers ─────────────────────────────────────────────

function isSourceFile(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.includes('node_modules/') || lower.includes('dist/') || lower.includes('build/')) return false;
  if (lower.endsWith('.test.ts') || lower.endsWith('.test.tsx') || lower.endsWith('.test.js')) return false;
  return SOURCE_EXTS.some(ext => lower.endsWith(ext));
}

function looksLikeUi(path: string): boolean {
  const lower = path.toLowerCase();
  return UI_DIRS.some(d => lower.startsWith(d) || lower.includes(`/${d}`));
}

function looksLikeService(path: string): boolean {
  const lower = path.toLowerCase();
  return SERVICE_DIRS.some(d => lower.startsWith(d) || lower.includes(`/${d}`));
}

// ── File download helper ────────────────────────────────────────────────────

async function downloadBatch(
  files: FileMeta[],
  fetchFile: (path: string) => Promise<string | null>,
): Promise<{ path: string; content: string }[]> {
  const results: { path: string; content: string }[] = [];
  const concurrency = 8;
  let cursor = 0;

  async function worker() {
    while (cursor < files.length) {
      const idx = cursor++;
      const f = files[idx];
      if (f.size > MAX_FILE_BYTES) continue;
      try {
        const content = await withTimeout(fetchFile(f.path), FETCH_FILE_TIMEOUT_MS, `fetch ${f.path}`);
        if (content != null) results.push({ path: f.path, content });
      } catch {
        /* ignore individual file errors */
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

// ── Heuristic extractors ────────────────────────────────────────────────────

/**
 * From UI sources, extract calls to a generic `api.<methodName>(...)` pattern
 * — this matches the project's frontend convention where `api.ts` exposes
 * methods that hit the backend. Also picks up direct `fetch('/api/...)` calls.
 */
function extractApiClientCalls(uiFiles: { path: string; content: string }[]) {
  const calls = new Map<string, Set<string>>(); // featureNode -> Set<methodName | route>

  const methodRe = /\bapi\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  const fetchRe = /fetch\(\s*[`'"]([^`'"]+)[`'"]/g;

  for (const f of uiFiles) {
    const feature = fileBaseName(f.path);
    const set = calls.get(feature) || new Set<string>();

    let m;
    while ((m = methodRe.exec(f.content))) set.add(m[1]);
    while ((m = fetchRe.exec(f.content))) {
      const url = m[1];
      if (url.startsWith('/api/') || url.includes('API_BASE')) set.add(url);
    }

    if (set.size > 0) calls.set(feature, set);
  }
  return calls;
}

/**
 * From backend sources, extract Express-style route declarations
 * (router.get('/path', ...), app.post('/path', ...)) and Python FastAPI
 * decorators (@app.get('/path')).
 */
function extractRoutes(serviceFiles: { path: string; content: string }[]) {
  type Route = { method: string; path: string; file: string; service: string };
  const routes: Route[] = [];

  const expressRe = /\b(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*[`'"]([^`'"]+)[`'"]/g;
  const fastapiRe = /@(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*[`'"]([^`'"]+)[`'"]/g;

  for (const f of serviceFiles) {
    const service = fileBaseName(f.path);
    let m;
    while ((m = expressRe.exec(f.content))) {
      routes.push({ method: m[1].toUpperCase(), path: m[2], file: f.path, service });
    }
    while ((m = fastapiRe.exec(f.content))) {
      routes.push({ method: m[1].toUpperCase(), path: m[2], file: f.path, service });
    }
  }
  return routes;
}

/**
 * Link api-client method names to backend routes by best-effort name overlap.
 * We score each (method, route) pair on token overlap and keep the best
 * match per client method.
 */
function linkClientToRoute(
  apiCalls: Map<string, Set<string>>,
  routes: ReturnType<typeof extractRoutes>,
) {
  const links: { method: string; route: typeof routes[number] }[] = [];
  const methodNames = new Set<string>();
  for (const set of apiCalls.values()) for (const m of set) methodNames.add(m);

  for (const method of methodNames) {
    // Skip raw URL entries (start with '/')
    if (method.startsWith('/')) continue;
    let best: { score: number; route: typeof routes[number] } | null = null;
    const mTokens = tokenize(method);
    for (const route of routes) {
      const rTokens = tokenize(`${route.method} ${route.path} ${route.service}`);
      const score = jaccard(mTokens, rTokens);
      if (!best || score > best.score) best = { score, route };
    }
    if (best && best.score > 0.15) links.push({ method, route: best.route });
  }
  return links;
}

// ── Graph assembly ──────────────────────────────────────────────────────────

function buildGraph(
  direction: 'ui-to-service' | 'service-to-ui',
  apiCalls: Map<string, Set<string>>,
  routes: ReturnType<typeof extractRoutes>,
  links: ReturnType<typeof linkClientToRoute>,
  stats: CodeGraph['stats'],
): CodeGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const addNode = (id: string, label: string, layer: GraphNode['layer'], file?: string) => {
    if (!nodes.has(id)) nodes.set(id, { id, label, layer, file });
  };
  const pushEdge = (a: string, b: string) =>
    edges.push(direction === 'ui-to-service' ? { from: a, to: b } : { from: b, to: a });

  // UI features → api-client methods → routes
  for (const [feature, methods] of apiCalls) {
    const uiId = `ui:${feature}`;
    addNode(uiId, feature, 'ui');
    for (const method of methods) {
      const apiId = `api:${method}`;
      addNode(apiId, method, 'api-client');
      pushEdge(uiId, apiId);
    }
  }

  for (const link of links) {
    const apiId = `api:${link.method}`;
    const routeId = `route:${link.route.method} ${link.route.path}`;
    addNode(routeId, `${link.route.method} ${link.route.path}`, 'route', link.route.file);
    pushEdge(apiId, routeId);

    const svcId = `svc:${link.route.service}`;
    addNode(svcId, link.route.service, 'service', link.route.file);
    pushEdge(routeId, svcId);
  }

  // Routes that no client method linked to — surface them in both directions
  for (const r of routes) {
    const routeId = `route:${r.method} ${r.path}`;
    if (!nodes.has(routeId)) {
      addNode(routeId, `${r.method} ${r.path}`, 'route', r.file);
      const svcId = `svc:${r.service}`;
      addNode(svcId, r.service, 'service', r.file);
      pushEdge(routeId, svcId);
    }
  }

  const dedupedEdges = dedupEdges(edges);
  const nodeArr = Array.from(nodes.values());
  return {
    direction,
    nodes: nodeArr,
    edges: dedupedEdges,
    mermaid: toMermaid(direction, nodeArr, dedupedEdges),
    stats,
    llm: null,
  };
}

function dedupEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  const out: GraphEdge[] = [];
  for (const e of edges) {
    const k = `${e.from}|${e.to}|${e.label || ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

// ── Mermaid rendering ───────────────────────────────────────────────────────

// Label, css class, and color per layer — declared in the fixed ui/api-client/route/service
// order that the classDef/class sections emit regardless of direction.
const LAYER_STYLE: Record<GraphNode['layer'], { label: string; cls: string; def: string }> = {
  ui: { label: 'UI Features', cls: 'ui', def: 'fill:#7c3aed22,stroke:#7c3aed,color:#e9d5ff' },
  'api-client': { label: 'API Client', cls: 'apiclient', def: 'fill:#0ea5e922,stroke:#0ea5e9,color:#bae6fd' },
  route: { label: 'Backend Routes', cls: 'route', def: 'fill:#22c55e22,stroke:#22c55e,color:#bbf7d0' },
  service: { label: 'Services', cls: 'service', def: 'fill:#f59e0b22,stroke:#f59e0b,color:#fde68a' },
};

function toMermaid(
  direction: 'ui-to-service' | 'service-to-ui',
  nodes: GraphNode[],
  edges: GraphEdge[],
): string {
  const lines: string[] = ['flowchart LR'];

  // Group nodes by layer once — drives both the subgraphs and the class assignments.
  const layers: Record<GraphNode['layer'], GraphNode[]> = {
    ui: [], 'api-client': [], route: [], service: [],
  };
  for (const n of nodes) layers[n.layer].push(n);

  const layerOrder: GraphNode['layer'][] =
    direction === 'ui-to-service'
      ? ['ui', 'api-client', 'route', 'service']
      : ['service', 'route', 'api-client', 'ui'];

  for (const layer of layerOrder) {
    if (layers[layer].length === 0) continue;
    lines.push(`  subgraph ${safeId(layer)}["${LAYER_STYLE[layer].label}"]`);
    for (const n of layers[layer]) {
      lines.push(`    ${safeId(n.id)}["${escapeLabel(n.label)}"]`);
    }
    lines.push('  end');
  }

  for (const e of edges) {
    lines.push(`  ${safeId(e.from)} --> ${safeId(e.to)}`);
  }

  // Color classes
  for (const style of Object.values(LAYER_STYLE)) {
    lines.push(`  classDef ${style.cls} ${style.def};`);
  }
  for (const [layer, style] of Object.entries(LAYER_STYLE)) {
    if (layers[layer].length) {
      lines.push(`  class ${layers[layer].map((n) => safeId(n.id)).join(',')} ${style.cls};`);
    }
  }

  return lines.join('\n');
}

function safeId(s: string): string {
  return 'n_' + s.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 60);
}

function escapeLabel(s: string): string {
  return s.replace(/"/g, "'").replace(/\n/g, ' ').slice(0, 80);
}

// ── String helpers ──────────────────────────────────────────────────────────

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[_/{}\-:.]/g, ' ')
      .split(/\s+/)
      .map(t => t.replace(/[^a-z0-9]/g, ''))
      .filter(t => t.length > 1 && !STOP_TOKENS.has(t)),
  );
}

const STOP_TOKENS = new Set(['api', 'get', 'post', 'put', 'patch', 'delete', 'id', 'by', 'the', 'a']);

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function fileBaseName(path: string): string {
  // e.g. frontend/src/components/AgentDetail.tsx → AgentDetail, api/src/routes/agents.ts → agents
  const base = path.split('/').pop() || path;
  return base.replace(/\.(t|j)sx?$|\.py$/, '');
}

// ── LLM refinement ──────────────────────────────────────────────────────────

async function refineWithLlm(graph: CodeGraph, llmConfigId: string) {
  const cfg = await getLlmConfig(llmConfigId);
  if (!cfg) return null;

  // Cap input — only send compact summary, never raw source.
  const summary = {
    direction: graph.direction,
    nodes: graph.nodes.map(n => ({ id: n.id, label: n.label, layer: n.layer })),
    edges: graph.edges.map(e => ({ from: e.from, to: e.to })),
  };

  const sys = [
    'You are a code-architecture assistant. You receive a JSON description of',
    'a call graph extracted from a repository (UI features, API-client methods,',
    'backend routes, services) and you produce a SIMPLIFIED, READABLE version',
    'of the same graph by:',
    '  - merging duplicate or trivially similar nodes (case-insensitive)',
    '  - dropping isolated / orphan nodes that have no edge',
    '  - grouping closely related nodes into clusters when helpful',
    '  - keeping the same shape (nodes/edges) and ids stable when possible',
    'Output strictly JSON of the form: {"nodes":[{id,label,layer}],"edges":[{from,to}]}.',
    'Use the same `layer` values: ui, api-client, route, service.',
    'Do NOT invent new nodes that were not in the input.',
  ].join(' ');

  const user = `Direction: ${graph.direction}\n\nInput graph:\n${JSON.stringify(summary)}\n\nReturn ONLY the simplified JSON.`;

  const provider = createProvider({
    provider: cfg.provider,
    model: cfg.model,
    endpoint: cfg.endpoint,
    apiKey: cfg.apiKey,
  });

  // Abort the underlying HTTP request on timeout — the withTimeout race below
  // stays as a safety net for providers that ignore the signal.
  const signal = AbortSignal.timeout(LLM_REFINE_TIMEOUT_MS);

  const resp = await withTimeout<any>(
    provider.chat([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], { maxTokens: 4000, temperature: cfg.temperature ?? 0.1, signal }),
    LLM_REFINE_TIMEOUT_MS,
    'LLM graph refinement',
  );

  const content = (resp?.content || '').trim();
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let parsed: any;
  try { parsed = JSON.parse(jsonMatch[0]); } catch { return null; }
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;

  // Filter to ids that still appear in input or stay as-is — but allow new merged labels.
  const inputIds = new Set(graph.nodes.map(n => n.id));
  const cleanedNodes: GraphNode[] = parsed.nodes
    .filter((n: any) => n && typeof n.id === 'string')
    .map((n: any) => ({
      id: n.id,
      label: String(n.label || n.id).slice(0, 80),
      layer: ['ui', 'api-client', 'route', 'service'].includes(n.layer) ? n.layer : 'ui',
    }));
  const validNodeIds = new Set(cleanedNodes.map(n => n.id));
  const cleanedEdges: GraphEdge[] = parsed.edges
    .filter((e: any) => e && typeof e.from === 'string' && typeof e.to === 'string')
    .filter((e: any) => validNodeIds.has(e.from) && validNodeIds.has(e.to));

  return {
    nodes: cleanedNodes,
    edges: cleanedEdges,
    llm: { provider: cfg.provider, model: cfg.model },
  };
}
