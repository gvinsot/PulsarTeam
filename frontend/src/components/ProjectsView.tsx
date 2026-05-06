import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  FolderGit2, Users, ListTodo, Clock, Search, Activity, BarChart3,
  Plus, X, Loader2, Trash2,
} from 'lucide-react';
import ProjectDetailModal from './ProjectDetailModal';
import api from '../api';

// ── Build daily activity series (fill gaps with zeros) ──────────────────────
function buildDailyActivity(dailyStats: { date: string; created: number; completed: number }[], days = 30) {
  const lookup = new Map(dailyStats.map(d => [d.date, d]));
  const result = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dayStr = d.toISOString().split('T')[0];
    const entry = lookup.get(dayStr);
    result.push({
      date: dayStr,
      created: entry?.created || 0,
      completed: entry?.completed || 0,
      total: (entry?.created || 0) + (entry?.completed || 0),
    });
  }
  return result;
}

// ── Mini bar chart (canvas) ──────────────────────────────────────────────────
const AXIS_COLOR = '#6b7280';
const AXIS_LABEL_FONT = '9px system-ui, sans-serif';
const PADDING_LEFT = 20;
const PADDING_BOTTOM = 14;

function MiniActivityChart({ data, height = 48 }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [width, setWidth] = useState(200);

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(entries => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const totalH = height + PADDING_BOTTOM;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data?.length) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    canvas.width = width * dpr;
    canvas.height = totalH * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${totalH}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, totalH);

    const chartW = width - PADDING_LEFT;
    const chartH = height;
    const maxVal = Math.max(...data.map(d => d.created + d.completed), 1);

    ctx.strokeStyle = AXIS_COLOR;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(PADDING_LEFT, 0);
    ctx.lineTo(PADDING_LEFT, chartH);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(PADDING_LEFT, chartH);
    ctx.lineTo(width, chartH);
    ctx.stroke();

    ctx.fillStyle = AXIS_COLOR;
    ctx.font = AXIS_LABEL_FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(String(maxVal), PADDING_LEFT - 3, 10);
    ctx.fillText('0', PADDING_LEFT - 3, chartH);

    const gap = 2;
    const barW = Math.max(2, (chartW - gap * (data.length - 1)) / data.length);

    data.forEach((d, i) => {
      const x = PADDING_LEFT + i * (barW + gap);
      const createdH = (d.created / maxVal) * (chartH - 2);
      const completedH = (d.completed / maxVal) * (chartH - 2);
      if (completedH > 0) {
        ctx.fillStyle = '#22c55e';
        ctx.globalAlpha = 0.8;
        const r = Math.min(2, barW / 2);
        roundRect(ctx, x, chartH - completedH, barW, completedH, r);
        ctx.fill();
      }
      if (createdH > 0) {
        ctx.fillStyle = '#a855f7';
        ctx.globalAlpha = 0.8;
        const r = Math.min(2, barW / 2);
        roundRect(ctx, x, chartH - completedH - createdH, barW, createdH, r);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    });

    ctx.fillStyle = AXIS_COLOR;
    ctx.font = AXIS_LABEL_FONT;
    ctx.textBaseline = 'top';
    const labelY = chartH + 3;
    const fmtDate = (d) => d?.date?.slice(5) || '';
    ctx.textAlign = 'left';
    ctx.fillText(fmtDate(data[0]), PADDING_LEFT, labelY);
    const mid = Math.floor(data.length / 2);
    ctx.textAlign = 'center';
    ctx.fillText(fmtDate(data[mid]), PADDING_LEFT + mid * (barW + gap) + barW / 2, labelY);
    ctx.textAlign = 'right';
    ctx.fillText(fmtDate(data[data.length - 1]), width, labelY);
  }, [data, width, height, totalH]);

  useEffect(() => { draw(); }, [draw]);

  if (!data?.length || data.every(d => d.created === 0 && d.completed === 0)) {
    return (
      <div ref={containerRef} className="w-full flex items-center justify-center text-dark-500 text-xs" style={{ height: totalH }}>
        No activity
      </div>
    );
  }
  return (
    <div ref={containerRef} className="w-full">
      <canvas ref={canvasRef} className="w-full" style={{ height: totalH }} />
    </div>
  );
}

function roundRect(ctx, x, y, w, h, r) {
  if (h <= 0 || w <= 0) return;
  r = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// ────────────────────────────────────────────────────────────────────────────

export default function ProjectsView({ agents = [], onRefresh }) {
  const [projects, setProjects] = useState([]);
  const [projectStats, setProjectStats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('name');
  const [selectedProjectId, setSelectedProjectId] = useState(null);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [newProject, setNewProject] = useState({ name: '', description: '' });

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [list, stats] = await Promise.all([
        api.getProjects(),
        api.getProjectStats(30).then(d => d.projects || []).catch(() => []),
      ]);
      setProjects(list);
      setProjectStats(stats);
    } catch (err) {
      console.error('Failed to load projects:', err);
      setProjects([]);
      setProjectStats([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const handleCreateProject = async () => {
    if (!newProject.name.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await api.createProject(newProject.name.trim(), newProject.description, '');
      setShowCreateModal(false);
      setNewProject({ name: '', description: '' });
      await reload();
      if (onRefresh) onRefresh();
    } catch (err: any) {
      setCreateError(err.message || 'Failed to create project');
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteProject = async (e, project) => {
    e.stopPropagation();
    if (!confirm(`Delete project "${project.name}"? Linked boards will be detached but not deleted.`)) return;
    try {
      await api.deleteProject(project.id);
      await reload();
    } catch (err: any) {
      alert(err.message || 'Failed to delete project');
    }
  };

  // Merge project rows with their stats and the agents whose tasks live on a project board
  const enrichedProjects = useMemo(() => {
    const statsById = new Map(projectStats.map(s => [s.id, s]));
    return projects.map(p => {
      const s = statsById.get(p.id) || {};
      const stats = {
        total: s.total || 0,
        done: s.done || 0,
        active: s.active || 0,
        waiting: s.waiting || 0,
        bugs: s.bugs || 0,
        features: s.features || 0,
        completion: s.completion || 0,
      };
      return {
        ...p,
        stats,
        dailyActivity: buildDailyActivity(s.daily || [], 30),
      };
    });
  }, [projects, projectStats]);

  const filteredProjects = useMemo(() => {
    let result = enrichedProjects;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(p => p.name.toLowerCase().includes(q));
    }
    if (sortBy === 'name') result = [...result].sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === 'tasks') result = [...result].sort((a, b) => b.stats.total - a.stats.total);
    else if (sortBy === 'completion') result = [...result].sort((a, b) => b.stats.completion - a.stats.completion);
    return result;
  }, [enrichedProjects, search, sortBy]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <FolderGit2 size={20} className="text-purple-400" />
          <h2 className="text-lg font-semibold text-dark-100">Projects</h2>
          <span className="text-xs text-dark-400 bg-dark-700 px-2 py-0.5 rounded-full">{filteredProjects.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-dark-400" />
            <input
              type="text"
              placeholder="Search projects..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="bg-dark-700 border border-dark-600 rounded pl-7 pr-3 py-1.5 text-sm text-dark-100 w-48"
            />
          </div>
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            className="bg-dark-700 border border-dark-600 rounded px-2 py-1.5 text-sm text-dark-100"
          >
            <option value="name">Sort: Name</option>
            <option value="tasks">Sort: Tasks</option>
            <option value="completion">Sort: Completion</option>
          </select>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded transition-colors"
          >
            <Plus size={14} />
            <span className="hidden sm:inline">New Project</span>
          </button>
        </div>
      </div>

      {/* Project Detail Modal */}
      {selectedProjectId && (
        <ProjectDetailModal
          projectId={selectedProjectId}
          agents={agents}
          onClose={() => setSelectedProjectId(null)}
          onChange={reload}
        />
      )}

      {/* Create Project Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => !creating && setShowCreateModal(false)}>
          <div className="bg-dark-800 border border-dark-600 rounded-xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-dark-100">New Project</h3>
              <button onClick={() => !creating && setShowCreateModal(false)} className="text-dark-400 hover:text-dark-100">
                <X size={18} />
              </button>
            </div>
            <p className="text-xs text-dark-400">A project groups one or more boards. Each board can later be linked to git repos and cloud storage.</p>
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-dark-300 mb-1">Project Name *</label>
                <input
                  type="text"
                  value={newProject.name}
                  onChange={e => setNewProject(p => ({ ...p, name: e.target.value }))}
                  placeholder="My Project"
                  className="w-full bg-dark-700 border border-dark-600 rounded px-3 py-2 text-sm text-dark-100 placeholder-dark-500 focus:border-purple-500 focus:outline-none"
                  disabled={creating}
                  autoFocus
                  onKeyDown={e => e.key === 'Enter' && handleCreateProject()}
                />
              </div>
              <div>
                <label className="block text-sm text-dark-300 mb-1">Description</label>
                <textarea
                  value={newProject.description}
                  onChange={e => setNewProject(p => ({ ...p, description: e.target.value }))}
                  placeholder="A short description..."
                  rows={3}
                  className="w-full bg-dark-700 border border-dark-600 rounded px-3 py-2 text-sm text-dark-100 placeholder-dark-500 focus:border-purple-500 focus:outline-none resize-y"
                  disabled={creating}
                />
              </div>
            </div>
            {createError && (
              <div className="bg-red-500/10 border border-red-500/30 rounded px-3 py-2 text-sm text-red-400">
                {createError}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setShowCreateModal(false)}
                disabled={creating}
                className="px-4 py-2 text-sm text-dark-300 hover:text-dark-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateProject}
                disabled={creating || !newProject.name.trim()}
                className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-dark-600 disabled:text-dark-400 text-white text-sm rounded transition-colors"
              >
                {creating && <Loader2 size={14} className="animate-spin" />}
                {creating ? 'Creating...' : 'Create Project'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Project Cards */}
      {loading ? (
        <div className="flex items-center justify-center py-12 text-dark-400">
          <Loader2 size={20} className="animate-spin mr-2" />
          Loading projects...
        </div>
      ) : filteredProjects.length === 0 ? (
        <div className="text-center py-12 text-dark-400">
          <FolderGit2 size={48} className="mx-auto mb-3 opacity-30" />
          <p>No projects yet</p>
          <p className="text-xs mt-1">Click "New Project" to create your first one.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredProjects.map(p => (
            <div
              key={p.id}
              className="bg-dark-800 border border-dark-700 rounded-xl p-4 hover:border-purple-500/50 transition-colors cursor-pointer"
              onClick={() => setSelectedProjectId(p.id)}
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-dark-100 truncate">{p.name}</h3>
                <div className="flex items-center gap-1">
                  <div className="p-1 rounded hover:bg-dark-600 text-dark-400" title="View details">
                    <BarChart3 size={14} />
                  </div>
                  <button
                    onClick={(e) => handleDeleteProject(e, p)}
                    className="p-1 rounded hover:bg-red-600/20 text-dark-400 hover:text-red-400 transition-colors"
                    title="Delete project"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {p.description && (
                <p className="text-xs text-dark-400 mb-3 line-clamp-2">{p.description}</p>
              )}

              <div className="mb-3">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] text-dark-500 uppercase tracking-wider">Activity (30d)</span>
                  <div className="flex items-center gap-3 text-[10px]">
                    <span className="flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 rounded-sm bg-purple-500" /> Created</span>
                    <span className="flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 rounded-sm bg-green-500" /> Done</span>
                  </div>
                </div>
                <MiniActivityChart data={p.dailyActivity} height={40} />
              </div>

              <div className="flex items-center gap-3 text-xs text-dark-400 flex-wrap">
                <span className="flex items-center gap-1" title="Boards"><KanbanIcon /> {p.boardCount || 0}</span>
                <span className="flex items-center gap-1" title="Repos"><GitIcon /> {p.repoCount || 0}</span>
                <span className="flex items-center gap-1" title="Storage"><CloudIcon /> {p.storageCount || 0}</span>
                <span className="flex items-center gap-1"><ListTodo size={11} className="text-purple-400" />{p.stats.total}</span>
                <span className="flex items-center gap-1"><Activity size={11} className="text-yellow-400" />{p.stats.active}</span>
                <span className="flex items-center gap-1"><Clock size={11} className="text-green-400" />{p.stats.completion}%</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Tiny inline icons (avoid extra imports)
function KanbanIcon() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2"><rect x="3" y="3" width="6" height="18" rx="1"/><rect x="11" y="3" width="6" height="11" rx="1"/><rect x="19" y="3" width="2" height="7" rx="1"/></svg>;
}
function GitIcon() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2"><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M6 8v8a4 4 0 0 0 4 4h0"/><path d="M18 8v2a4 4 0 0 1-4 4h-2"/></svg>;
}
function CloudIcon() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2"><path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.7 1.5A4 4 0 0 0 6 19h11.5z"/></svg>;
}
