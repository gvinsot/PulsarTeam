import { useState, useCallback } from 'react';
import {
  FolderGit2, Plus, X, Loader2, Trash2, Settings, Check, LayoutGrid,
} from 'lucide-react';
import { api } from '../api';
import { useEscapeKey } from '../hooks/useDismiss';
import ProjectDetailModal from './ProjectDetailModal';

// ── ProjectDrawer ────────────────────────────────────────────────────────────
// Temporary left-side drawer that is the single entry point for projects:
//  - "All Projects" (clears the filter) + one row per project (sets the filter)
//  - create / delete inline, deep management via ProjectDetailModal
// Replaces the former top-level "Projects" view and the header project <select>.
export default function ProjectDrawer({
  open,
  onClose,
  projects = [],
  projectFilter = '',
  onSelect,
  agents = [],
  onProjectsChanged,
}) {
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [newProject, setNewProject] = useState({ name: '', description: '' });

  // Esc closes the drawer, but only when no child modal owns the foreground
  // (those handle their own dismissal).
  useEscapeKey(onClose, open && !selectedProjectId && !showCreate);

  const handleCreate = useCallback(async () => {
    if (!newProject.name.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await api.createProject(newProject.name.trim(), newProject.description, '');
      setShowCreate(false);
      setNewProject({ name: '', description: '' });
      onProjectsChanged?.();
    } catch (err: any) {
      setCreateError(err.message || 'Failed to create project');
    } finally {
      setCreating(false);
    }
  }, [newProject, onProjectsChanged]);

  const handleDelete = useCallback(async (e, project) => {
    e.stopPropagation();
    if (!confirm(`Delete project "${project.name}"? Linked boards will be detached but not deleted.`)) return;
    try {
      await api.deleteProject(project.id);
      onProjectsChanged?.();
    } catch (err: any) {
      alert(err.message || 'Failed to delete project');
    }
  }, [onProjectsChanged]);

  const pick = (id) => { onSelect(id); onClose(); };

  const rowClass = (active) =>
    `w-full flex items-center justify-between gap-2 px-3 py-2 text-sm rounded-lg transition-colors ${
      active
        ? 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/30'
        : 'text-dark-300 hover:bg-dark-800 border border-transparent'
    }`;

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-[70] flex">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

          {/* Panel */}
          <div className="relative w-72 max-w-[85vw] h-full bg-dark-900 border-r border-dark-700 shadow-2xl flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-dark-700 shrink-0">
              <div className="flex items-center gap-2">
                <FolderGit2 size={18} className="text-purple-400" />
                <h2 className="text-sm font-semibold text-dark-100">Projects</h2>
                <span className="text-[10px] text-dark-400 bg-dark-700 px-1.5 py-0.5 rounded-full">{projects.length}</span>
              </div>
              <button
                onClick={onClose}
                className="p-1.5 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors"
                title="Close"
              >
                <X size={16} />
              </button>
            </div>

            {/* New project */}
            <div className="px-3 py-2 border-b border-dark-700/60 shrink-0">
              <button
                onClick={() => { setCreateError(null); setShowCreate(true); }}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded-lg transition-colors"
              >
                <Plus size={14} /> New Project
              </button>
            </div>

            {/* Project list */}
            <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
              {/* All Projects (clears the filter) */}
              <button onClick={() => pick('')} className={rowClass(projectFilter === '')} title="Show everything across all projects">
                <span className="flex items-center gap-2 min-w-0">
                  <LayoutGrid size={14} className={projectFilter === '' ? 'text-indigo-400' : 'text-dark-500'} />
                  <span className="truncate font-medium">All Projects</span>
                </span>
                {projectFilter === '' && <Check size={14} className="text-indigo-400 shrink-0" />}
              </button>

              {projects.map(p => {
                const active = projectFilter === p.id;
                return (
                  <div key={p.id} className={`${rowClass(active)} group`}>
                    <button
                      onClick={() => pick(p.id)}
                      className="flex items-center gap-2 min-w-0 flex-1 text-left"
                      title={`Filter by ${p.name}`}
                    >
                      <FolderGit2 size={14} className={active ? 'text-purple-400 shrink-0' : 'text-dark-500 shrink-0'} />
                      <span className="truncate">{p.name}</span>
                    </button>
                    <div className="flex items-center gap-0.5 shrink-0">
                      {active && <Check size={14} className="text-indigo-400" />}
                      <button
                        onClick={(e) => { e.stopPropagation(); setSelectedProjectId(p.id); }}
                        className="p-1 rounded text-dark-400 hover:text-dark-100 hover:bg-dark-700 transition-colors opacity-60 group-hover:opacity-100"
                        title="Manage project (boards, repos, storage, stats)"
                      >
                        <Settings size={13} />
                      </button>
                      <button
                        onClick={(e) => handleDelete(e, p)}
                        className="p-1 rounded text-dark-400 hover:text-red-400 hover:bg-red-600/10 transition-colors opacity-60 group-hover:opacity-100"
                        title="Delete project"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}

              {projects.length === 0 && (
                <p className="px-3 py-6 text-center text-xs text-dark-500">
                  No projects yet. Click "New Project" to create your first one.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Deep management — sits above the drawer (z-[80]) */}
      {selectedProjectId && (
        <ProjectDetailModal
          projectId={selectedProjectId}
          agents={agents}
          onClose={() => setSelectedProjectId(null)}
          onChange={onProjectsChanged}
        />
      )}

      {/* Create Project modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[90] p-4" onClick={() => !creating && setShowCreate(false)}>
          <div className="bg-dark-800 border border-dark-600 rounded-xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-dark-100">New Project</h3>
              <button onClick={() => !creating && setShowCreate(false)} className="text-dark-400 hover:text-dark-100">
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
                  onKeyDown={e => e.key === 'Enter' && handleCreate()}
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
                onClick={() => setShowCreate(false)}
                disabled={creating}
                className="px-4 py-2 text-sm text-dark-300 hover:text-dark-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
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
    </>
  );
}
