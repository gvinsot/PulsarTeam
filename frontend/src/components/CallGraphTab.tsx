import { useEffect, useRef, useState, useCallback } from 'react';
import { Loader2, AlertCircle, ArrowRightLeft, Play, ZoomIn, ZoomOut, Maximize2, Sparkles } from 'lucide-react';
import mermaid from 'mermaid';
import { api } from '../api';

type Direction = 'ui-to-service' | 'service-to-ui';

interface GraphResult {
  direction: Direction;
  nodes: Array<{ id: string; label: string; layer: string; file?: string }>;
  edges: Array<{ from: string; to: string }>;
  mermaid: string;
  stats?: { filesScanned: number; uiFiles: number; serviceFiles: number; truncated: boolean };
  llm?: { provider: string; model: string } | null;
  fetchedAt?: string;
  ref?: string;
}

let mermaidInited = false;
function initMermaid() {
  if (mermaidInited) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'loose',
    flowchart: { useMaxWidth: false, htmlLabels: true, curve: 'basis' },
  });
  mermaidInited = true;
}

export default function CallGraphTab({ owner, repo, boardId }: { owner: string; repo: string; boardId: string }) {
  const [direction, setDirection] = useState<Direction>('ui-to-service');
  const [data, setData] = useState<GraphResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [svg, setSvg] = useState<string>('');

  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Run analysis on demand.
  const runAnalysis = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.analyzeCodeGraph(owner, repo, boardId, { direction, refresh });
      setData(result);
    } catch (err: any) {
      setError(err.message || 'Analysis failed');
    } finally {
      setLoading(false);
    }
  }, [owner, repo, boardId, direction]);

  // Render mermaid → SVG when data changes.
  useEffect(() => {
    if (!data?.mermaid) { setSvg(''); return; }
    initMermaid();
    let cancelled = false;
    (async () => {
      try {
        const id = `cg_${Math.random().toString(36).slice(2)}`;
        const { svg } = await mermaid.render(id, data.mermaid);
        if (!cancelled) setSvg(svg);
      } catch (err: any) {
        if (!cancelled) setError(`Diagram render failed: ${err.message}`);
      }
    })();
    return () => { cancelled = true; };
  }, [data]);

  // Reset zoom/pan when direction or data switches.
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, [data?.direction]);

  // ── Zoom & pan handlers ──────────────────────────────────────────────
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom(z => Math.max(0.2, Math.min(4, z * factor)));
  };

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: pan.x, baseY: pan.y };
  };
  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    setPan({
      x: dragRef.current.baseX + (e.clientX - dragRef.current.startX),
      y: dragRef.current.baseY + (e.clientY - dragRef.current.startY),
    });
  };
  const onMouseUp = () => { dragRef.current = null; };

  const fitToContainer = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-1 pb-3 border-b border-dark-700 mb-3">
        <div className="flex items-center bg-dark-800 border border-dark-600 rounded-lg overflow-hidden text-xs">
          <button
            onClick={() => setDirection('ui-to-service')}
            className={`px-3 py-1.5 transition-colors ${direction === 'ui-to-service' ? 'bg-purple-500/30 text-purple-200' : 'text-dark-300 hover:text-dark-100'}`}
          >
            UI → Services
          </button>
          <button
            onClick={() => setDirection('service-to-ui')}
            className={`px-3 py-1.5 transition-colors ${direction === 'service-to-ui' ? 'bg-purple-500/30 text-purple-200' : 'text-dark-300 hover:text-dark-100'}`}
          >
            Services → UI
          </button>
        </div>

        <button
          onClick={() => runAnalysis(false)}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-500 hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-xs font-medium transition-colors"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          {data ? 'Re-analyze' : 'Analyze'}
        </button>

        {data && (
          <button
            onClick={() => runAnalysis(true)}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-dark-700 hover:bg-dark-600 text-dark-100 rounded-lg text-xs transition-colors disabled:opacity-50"
            title="Bypass cache and recompute"
          >
            <Sparkles size={12} />
            Refresh
          </button>
        )}

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setZoom(z => Math.max(0.2, z * 0.9))}
            className="p-1.5 bg-dark-800 border border-dark-600 rounded text-dark-300 hover:text-dark-100"
            title="Zoom out"
          ><ZoomOut size={14} /></button>
          <span className="text-xs text-dark-400 w-12 text-center">{Math.round(zoom * 100)}%</span>
          <button
            onClick={() => setZoom(z => Math.min(4, z * 1.1))}
            className="p-1.5 bg-dark-800 border border-dark-600 rounded text-dark-300 hover:text-dark-100"
            title="Zoom in"
          ><ZoomIn size={14} /></button>
          <button
            onClick={fitToContainer}
            className="p-1.5 bg-dark-800 border border-dark-600 rounded text-dark-300 hover:text-dark-100"
            title="Reset view"
          ><Maximize2 size={14} /></button>
        </div>
      </div>

      {/* Stats / status */}
      {data && (
        <div className="flex items-center gap-3 flex-wrap text-[11px] text-dark-400 mb-2 px-1">
          <span>{data.nodes.length} nodes · {data.edges.length} edges</span>
          {data.stats && (
            <span>scanned {data.stats.filesScanned} files (UI: {data.stats.uiFiles} / service: {data.stats.serviceFiles})</span>
          )}
          {data.stats?.truncated && <span className="text-amber-400">⚠ tree truncated by GitHub</span>}
          {data.llm && (
            <span className="text-purple-300">simplified by {data.llm.provider}/{data.llm.model}</span>
          )}
        </div>
      )}

      {/* Body */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-hidden bg-dark-950 border border-dark-700 rounded-xl relative cursor-grab active:cursor-grabbing"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      >
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-dark-950/80 z-10">
            <Loader2 size={24} className="animate-spin text-purple-400" />
            <span className="ml-2 text-dark-300 text-sm">Analyzing repository…</span>
          </div>
        )}

        {error && (
          <div className="absolute top-3 left-3 right-3 flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg z-10">
            <AlertCircle size={14} className="text-red-400 shrink-0" />
            <span className="text-xs text-red-300">{error}</span>
          </div>
        )}

        {!data && !loading && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6">
            <ArrowRightLeft className="w-10 h-10 text-dark-600 mb-3" />
            <h3 className="text-sm font-semibold text-dark-200">Call-graph analysis</h3>
            <p className="text-xs text-dark-400 mt-1 max-w-md">
              Scans the repository's source files and builds a graph linking UI features
              to backend services. Pick a direction above and click <strong>Analyze</strong>.
              The optional LLM step (configured in Admin Settings) is used to simplify the
              graph for readability.
            </p>
          </div>
        )}

        {svg && (
          <div
            className="absolute top-0 left-0 origin-top-left will-change-transform select-none"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        )}
      </div>
    </div>
  );
}
