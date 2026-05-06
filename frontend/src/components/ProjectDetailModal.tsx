import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  X, Users, ListTodo, Activity, FolderGit2, BarChart3, FileText, Save, Loader2,
  KanbanSquare, Plus, Trash2, GitBranch, Cloud, Link as LinkIcon, ExternalLink, GitCommit,
} from 'lucide-react';
import ProjectStats from './ProjectStats';
import GitHubActivityModal from './GitHubActivityModal';
import { api } from '../api';

const TABS = [
  { id: 'overview',   label: 'Overview',    icon: FolderGit2 },
  { id: 'boards',     label: 'Boards',      icon: KanbanSquare },
  { id: 'repos',      label: 'Repos',       icon: GitBranch },
  { id: 'storage',    label: 'Storage',     icon: Cloud },
  { id: 'context',    label: 'Context',     icon: FileText },
  { id: 'statistics', label: 'Statistics',  icon: BarChart3 },
];

export default function ProjectDetailModal({ projectId, agents = [], onClose, onChange }) {
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getProject(projectId);
      setProject(data);
    } catch (err) {
      console.error('Failed to load project:', err);
      setProject(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const projectAgents = useMemo(() => {
    if (!project?.boards?.length) return [];
    const boardIds = new Set(project.boards.map(b => b.id));
    return agents.filter(a => boardIds.has(a.board_id || a.boardId));
  }, [project, agents]);

  const handleChanged = () => {
    reload();
    if (onChange) onChange();
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-dark-900 border border-dark-700 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: '90vw', height: '90vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-dark-700 shrink-0">
          <div className="flex items-center gap-3">
            <FolderGit2 size={22} className="text-purple-400" />
            <h2 className="text-xl font-bold text-dark-100">{project?.name || '...'}</h2>
          </div>
          <button onClick={onClose} className="p-2 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-6 pt-3 pb-0 border-b border-dark-700 shrink-0">
          {TABS.map(tab => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors relative ${
                  isActive
                    ? 'text-purple-400 bg-dark-800 border border-dark-700 border-b-transparent -mb-px'
                    : 'text-dark-400 hover:text-dark-200 hover:bg-dark-800/50'
                }`}
              >
                <Icon size={15} />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading || !project ? (
            <div className="flex items-center justify-center py-12 text-dark-400">
              <Loader2 size={20} className="animate-spin mr-2" />
              Loading...
            </div>
          ) : (
            <>
              {activeTab === 'overview' && <OverviewTab project={project} agents={projectAgents} />}
              {activeTab === 'boards' && <BoardsTab project={project} onChanged={handleChanged} />}
              {activeTab === 'repos' && <ReposTab project={project} onChanged={handleChanged} />}
              {activeTab === 'storage' && <StoragesTab project={project} onChanged={handleChanged} />}
              {activeTab === 'context' && <ContextTab project={project} onSaved={handleChanged} />}
              {activeTab === 'statistics' && <StatisticsTab project={project} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Overview ─────────────────────────────────────────────────────────────── */
function OverviewTab({ project, agents }) {
  const boards = project.boards || [];
  const repos = project.repos || [];
  const storages = project.storages || [];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard icon={<KanbanSquare size={16} />} label="Boards" value={boards.length} color="text-blue-400" />
        <SummaryCard icon={<GitBranch size={16} />} label="Repos" value={repos.length} color="text-green-400" />
        <SummaryCard icon={<Cloud size={16} />} label="Storage" value={storages.length} color="text-amber-400" />
        <SummaryCard icon={<Users size={16} />} label="Agents" value={agents.length} color="text-purple-400" />
      </div>

      {project.description && (
        <Section title="Description" icon={<FileText size={16} className="text-dark-400" />}>
          <p className="text-sm text-dark-200 whitespace-pre-wrap">{project.description}</p>
        </Section>
      )}

      <Section title="Boards" icon={<KanbanSquare size={16} className="text-blue-400" />}>
        {boards.length === 0 ? (
          <p className="text-dark-500 text-sm">No boards linked yet. Add one from the Boards tab.</p>
        ) : (
          <ul className="space-y-1.5">
            {boards.map(b => (
              <li key={b.id} className="flex items-center gap-2 text-sm text-dark-200 bg-dark-800 border border-dark-700 rounded-lg px-3 py-2">
                <KanbanSquare size={14} className="text-blue-400 shrink-0" />
                <span className="truncate">{b.name}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/* ── Boards (link/unlink) ─────────────────────────────────────────────────── */
function BoardsTab({ project, onChanged }) {
  const [allBoards, setAllBoards] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getBoards().then(setAllBoards).catch(() => setAllBoards([]));
  }, []);

  const linkedIds = new Set((project.boards || []).map(b => b.id));
  const linkable = allBoards.filter(b => !linkedIds.has(b.id) && !b.project_id);

  const link = async (boardId) => {
    setBusy(true);
    try { await api.attachBoardToProject(project.id, boardId); onChanged(); }
    finally { setBusy(false); }
  };
  const unlink = async (boardId) => {
    setBusy(true);
    try { await api.detachBoardFromProject(project.id, boardId); onChanged(); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h3 className="text-sm font-semibold text-dark-200 mb-3">Linked Boards</h3>
        {(project.boards || []).length === 0 ? (
          <p className="text-dark-500 text-sm">No boards linked.</p>
        ) : (
          <ul className="space-y-1.5">
            {project.boards.map(b => (
              <li key={b.id} className="flex items-center justify-between bg-dark-800 border border-dark-700 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2 text-sm text-dark-100">
                  <KanbanSquare size={14} className="text-blue-400" />
                  {b.name}
                </div>
                <button
                  disabled={busy}
                  onClick={() => unlink(b.id)}
                  className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 flex items-center gap-1"
                >
                  <Trash2 size={12} /> Unlink
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-dark-200 mb-3">Available Boards</h3>
        {linkable.length === 0 ? (
          <p className="text-dark-500 text-sm">No free boards. Each board can belong to a single project.</p>
        ) : (
          <ul className="space-y-1.5">
            {linkable.map(b => (
              <li key={b.id} className="flex items-center justify-between bg-dark-800 border border-dark-700 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2 text-sm text-dark-200">
                  <KanbanSquare size={14} className="text-dark-500" />
                  {b.name}
                </div>
                <button
                  disabled={busy}
                  onClick={() => link(b.id)}
                  className="text-xs text-purple-400 hover:text-purple-300 disabled:opacity-50 flex items-center gap-1"
                >
                  <LinkIcon size={12} /> Link
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ── Repos ────────────────────────────────────────────────────────────────── */
function ReposTab({ project, onChanged }) {
  const boards = project.boards || [];
  const [activityTarget, setActivityTarget] = useState(null);

  if (boards.length === 0) {
    return <p className="text-dark-500 text-sm">Link at least one board first to attach git repos.</p>;
  }

  return (
    <div className="space-y-6 max-w-4xl">
      {boards.map(b => (
        <BoardReposPanel key={b.id} board={b} onChanged={onChanged} onShowActivity={setActivityTarget} />
      ))}
      {activityTarget && (
        <GitHubActivityModal
          owner={activityTarget.owner}
          repo={activityTarget.repo}
          onClose={() => setActivityTarget(null)}
        />
      )}
    </div>
  );
}

function BoardReposPanel({ board, onChanged, onShowActivity }) {
  const [repos, setRepos] = useState([]);
  const [available, setAvailable] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickedRepo, setPickedRepo] = useState('');

  const reload = useCallback(async () => {
    const list = await api.getBoardRepos(board.id).catch(() => []);
    setRepos(list);
  }, [board.id]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    api.getAvailableRepos().then(setAvailable).catch(() => setAvailable([]));
  }, []);

  const onAdd = async () => {
    if (!pickedRepo) return;
    setBusy(true);
    try {
      const repo = available.find(r => r.fullName === pickedRepo);
      if (!repo) return;
      await api.addBoardRepo(board.id, {
        provider: repo.provider,
        fullName: repo.fullName,
        htmlUrl: repo.htmlUrl,
        defaultBranch: repo.defaultBranch || '',
      });
      setShowAdd(false);
      setPickedRepo('');
      await reload();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (id) => {
    setBusy(true);
    try { await api.removeBoardRepo(board.id, id); await reload(); onChanged(); }
    finally { setBusy(false); }
  };

  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-medium text-dark-100">
          <KanbanSquare size={14} className="text-blue-400" />
          {board.name}
        </div>
        <button
          onClick={() => setShowAdd(s => !s)}
          className="flex items-center gap-1 px-2.5 py-1 text-xs bg-purple-600/80 hover:bg-purple-500 text-white rounded transition-colors"
        >
          <Plus size={12} /> Add Repo
        </button>
      </div>

      {showAdd && (
        <div className="mb-3 flex items-center gap-2">
          <select
            value={pickedRepo}
            onChange={e => setPickedRepo(e.target.value)}
            className="flex-1 bg-dark-700 border border-dark-600 rounded px-2 py-1.5 text-sm text-dark-100"
          >
            <option value="">Select a repo from configured connections...</option>
            {available.map(r => (
              <option key={`${r.provider}/${r.fullName}`} value={r.fullName}>
                [{r.provider}] {r.fullName}
              </option>
            ))}
          </select>
          <button
            onClick={onAdd}
            disabled={!pickedRepo || busy}
            className="px-3 py-1.5 text-sm bg-purple-600 hover:bg-purple-500 text-white rounded disabled:opacity-50"
          >
            Add
          </button>
        </div>
      )}

      {repos.length === 0 ? (
        <p className="text-dark-500 text-sm">No repos linked to this board.</p>
      ) : (
        <ul className="space-y-1.5">
          {repos.map(r => {
            const [owner, repo] = (r.full_name || '').split('/');
            return (
              <li key={r.id} className="flex items-center justify-between bg-dark-700/50 border border-dark-600 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2 text-sm text-dark-100 min-w-0">
                  <GitBranch size={14} className="text-green-400 shrink-0" />
                  <span className="truncate">{r.full_name}</span>
                  <span className="text-xs text-dark-500">[{r.provider}]</span>
                  {r.html_url && (
                    <a href={r.html_url} target="_blank" rel="noopener noreferrer" className="text-dark-400 hover:text-dark-100 ml-1">
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {r.provider === 'github' && owner && repo && (
                    <button
                      onClick={() => onShowActivity({ owner, repo })}
                      className="p-1 rounded hover:bg-dark-600 text-dark-400 hover:text-dark-100 transition-colors"
                      title="View activity"
                    >
                      <GitCommit size={14} />
                    </button>
                  )}
                  <button
                    onClick={() => onRemove(r.id)}
                    disabled={busy}
                    className="p-1 rounded hover:bg-red-600/20 text-dark-400 hover:text-red-400 transition-colors disabled:opacity-50"
                    title="Remove"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ── Storages ─────────────────────────────────────────────────────────────── */
function StoragesTab({ project, onChanged }) {
  const boards = project.boards || [];
  if (boards.length === 0) {
    return <p className="text-dark-500 text-sm">Link at least one board first to attach cloud storage.</p>;
  }
  return (
    <div className="space-y-6 max-w-4xl">
      {boards.map(b => (
        <BoardStoragesPanel key={b.id} board={b} onChanged={onChanged} />
      ))}
    </div>
  );
}

function BoardStoragesPanel({ board, onChanged }) {
  const [storages, setStorages] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ provider: 'onedrive', displayName: '', path: '' });

  const reload = useCallback(async () => {
    const list = await api.getBoardStorages(board.id).catch(() => []);
    setStorages(list);
  }, [board.id]);
  useEffect(() => { reload(); }, [reload]);

  const onAdd = async () => {
    if (!draft.displayName.trim()) return;
    setBusy(true);
    try {
      await api.addBoardStorage(board.id, draft);
      setShowAdd(false);
      setDraft({ provider: 'onedrive', displayName: '', path: '' });
      await reload();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (id) => {
    setBusy(true);
    try { await api.removeBoardStorage(board.id, id); await reload(); onChanged(); }
    finally { setBusy(false); }
  };

  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-medium text-dark-100">
          <KanbanSquare size={14} className="text-blue-400" />
          {board.name}
        </div>
        <button
          onClick={() => setShowAdd(s => !s)}
          className="flex items-center gap-1 px-2.5 py-1 text-xs bg-amber-600/80 hover:bg-amber-500 text-white rounded transition-colors"
        >
          <Plus size={12} /> Add Storage
        </button>
      </div>

      {showAdd && (
        <div className="mb-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
          <select
            value={draft.provider}
            onChange={e => setDraft(d => ({ ...d, provider: e.target.value }))}
            className="bg-dark-700 border border-dark-600 rounded px-2 py-1.5 text-sm text-dark-100"
          >
            <option value="onedrive">OneDrive</option>
            <option value="google_drive">Google Drive</option>
          </select>
          <input
            type="text"
            placeholder="Display name"
            value={draft.displayName}
            onChange={e => setDraft(d => ({ ...d, displayName: e.target.value }))}
            className="bg-dark-700 border border-dark-600 rounded px-2 py-1.5 text-sm text-dark-100"
          />
          <input
            type="text"
            placeholder="Path / folder ID (optional)"
            value={draft.path}
            onChange={e => setDraft(d => ({ ...d, path: e.target.value }))}
            className="bg-dark-700 border border-dark-600 rounded px-2 py-1.5 text-sm text-dark-100"
          />
          <button
            onClick={onAdd}
            disabled={busy || !draft.displayName.trim()}
            className="sm:col-span-3 px-3 py-1.5 text-sm bg-amber-600 hover:bg-amber-500 text-white rounded disabled:opacity-50"
          >
            Add
          </button>
        </div>
      )}

      {storages.length === 0 ? (
        <p className="text-dark-500 text-sm">No storage linked to this board.</p>
      ) : (
        <ul className="space-y-1.5">
          {storages.map(s => (
            <li key={s.id} className="flex items-center justify-between bg-dark-700/50 border border-dark-600 rounded-lg px-3 py-2">
              <div className="flex items-center gap-2 text-sm text-dark-100 min-w-0">
                <Cloud size={14} className="text-amber-400 shrink-0" />
                <span className="truncate">{s.display_name}</span>
                <span className="text-xs text-dark-500">[{s.provider}]</span>
                {s.path && <span className="text-xs text-dark-400 truncate">— {s.path}</span>}
              </div>
              <button
                onClick={() => onRemove(s.id)}
                disabled={busy}
                className="p-1 rounded hover:bg-red-600/20 text-dark-400 hover:text-red-400 transition-colors disabled:opacity-50"
                title="Remove"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── Context (description + rules editing) ────────────────────────────────── */
function ContextTab({ project, onSaved }) {
  const [name, setName] = useState(project.name || '');
  const [description, setDescription] = useState(project.description || '');
  const [rules, setRules] = useState(project.rules || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(project.name || '');
    setDescription(project.description || '');
    setRules(project.rules || '');
  }, [project]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await api.updateProject(project.id, { name, description, rules });
      setSaved(true);
      onSaved?.();
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      alert(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <label className="block text-xs text-dark-400 mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          className="w-full bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-dark-100 focus:outline-none focus:border-cyan-500/50"
        />
      </div>
      <div>
        <label className="block text-xs text-dark-400 mb-1">Description</label>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Tech stack, architecture, key patterns..."
          rows={3}
          className="w-full bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-dark-100 placeholder-dark-500 resize-y focus:outline-none focus:border-cyan-500/50"
        />
      </div>
      <div>
        <label className="block text-xs text-dark-400 mb-1">Rules &amp; Instructions</label>
        <textarea
          value={rules}
          onChange={e => setRules(e.target.value)}
          placeholder="Define rules agents must follow when working on this project..."
          rows={4}
          className="w-full bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-dark-100 placeholder-dark-500 resize-y focus:outline-none focus:border-cyan-500/50"
        />
      </div>
      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {saving ? 'Saving...' : 'Save'}
        </button>
        {saved && <span className="text-xs text-green-400">Saved</span>}
      </div>
    </div>
  );
}

/* ── Statistics ───────────────────────────────────────────────────────────── */
function StatisticsTab({ project }) {
  return <ProjectStats projectName={project.name} onClose={() => {}} embedded />;
}

/* ── Shared subcomponents ─────────────────────────────────────────────────── */
function SummaryCard({ icon, label, value, color }) {
  return (
    <div className="bg-dark-800 border border-dark-700 rounded-lg px-4 py-3">
      <div className={`flex items-center gap-1.5 ${color} mb-1`}>
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p className="text-lg font-bold text-dark-100">{value}</p>
    </div>
  );
}

function Section({ title, icon, children }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-dark-200 flex items-center gap-2 mb-3">
        {icon} {title}
      </h3>
      {children}
    </div>
  );
}
