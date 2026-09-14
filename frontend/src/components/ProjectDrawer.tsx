import { useState, useCallback, useRef } from 'react';
import type { ChangeEvent, MouseEvent } from 'react';
import {
  FolderGit2,
  Plus,
  X,
  Loader2,
  Trash2,
  Settings,
  Check,
  LayoutGrid,
  Download,
  Upload,
  AlertTriangle,
} from 'lucide-react';
import { api } from '../api';
import { useEscapeKey } from '../hooks/useDismiss';
import ProjectDetailModal from './ProjectDetailModal';
import { errorMessage } from '../utils/errors';
import type { Agent, ProjectConfigBundle, ProjectImportResult, ProjectListItem } from '../types';

/** Filename-safe slug of a project name, matching what the API suggests. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'export'
  );
}

/** Save a JSON document to the user's disk without a server round-trip. */
function downloadJson(filename: string, data: unknown): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// ── ProjectDrawer ────────────────────────────────────────────────────────────
// Temporary left-side drawer that is the single entry point for projects:
//  - "All Projects" (clears the filter) + one row per project (sets the filter)
//  - create / delete inline, deep management via ProjectDetailModal
// Replaces the former top-level "Projects" view and the header project <select>.
interface ProjectDrawerProps {
  open: boolean;
  onClose: () => void;
  projects?: ProjectListItem[];
  /** A project id, or '' for "All Projects". */
  projectFilter?: string;
  onSelect: (projectId: string) => void;
  agents?: Agent[];
  onProjectsChanged?: () => void;
}

export default function ProjectDrawer({
  open,
  onClose,
  projects = [],
  projectFilter = '',
  onSelect,
  agents = [],
  onProjectsChanged,
}: ProjectDrawerProps) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newProject, setNewProject] = useState({ name: '', description: '' });
  // Configuration transfer. `exportingId` drives the per-row spinner; the
  // import result stays on screen because it is the only place the server's
  // warnings (missing API keys, dropped references) are ever shown.
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ProjectImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Esc closes the drawer, but only when no child modal owns the foreground
  // (those handle their own dismissal).
  useEscapeKey(onClose, open && !selectedProjectId && !showCreate && !importResult);

  const handleCreate = useCallback(async () => {
    if (!newProject.name.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await api.createProject(newProject.name.trim(), newProject.description, '');
      setShowCreate(false);
      setNewProject({ name: '', description: '' });
      onProjectsChanged?.();
    } catch (err) {
      setCreateError(errorMessage(err) || 'Failed to create project');
    } finally {
      setCreating(false);
    }
  }, [newProject, onProjectsChanged]);

  const handleDelete = useCallback(
    async (e: MouseEvent<HTMLButtonElement>, project: ProjectListItem) => {
      e.stopPropagation();
      if (
        !confirm(
          `Delete project "${project.name}"? Linked boards will be detached but not deleted.`
        )
      )
        return;
      try {
        await api.deleteProject(project.id);
        onProjectsChanged?.();
      } catch (err) {
        alert(errorMessage(err) || 'Failed to delete project');
      }
    },
    [onProjectsChanged]
  );

  const handleExport = useCallback(
    async (e: MouseEvent<HTMLButtonElement>, project: ProjectListItem) => {
      e.stopPropagation();
      setExportingId(project.id);
      try {
        const bundle = await api.exportProject(project.id);
        downloadJson(`pulsarteam-project-${slugify(project.name)}.json`, bundle);
      } catch (err) {
        alert(errorMessage(err) || 'Failed to export project');
      } finally {
        setExportingId(null);
      }
    },
    []
  );

  const handleImportFile = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset the input so re-picking the same file fires `change` again.
      e.target.value = '';
      if (!file) return;

      setImporting(true);
      setImportError(null);
      setImportResult(null);
      try {
        let bundle: ProjectConfigBundle;
        try {
          bundle = JSON.parse(await file.text()) as ProjectConfigBundle;
        } catch {
          throw new Error(`"${file.name}" is not valid JSON`);
        }
        const result = await api.importProject(bundle);
        setImportResult(result);
        onProjectsChanged?.();
      } catch (err) {
        setImportError(errorMessage(err) || 'Failed to import project');
      } finally {
        setImporting(false);
      }
    },
    [onProjectsChanged]
  );

  const pick = (id: string) => {
    onSelect(id);
    onClose();
  };

  const rowClass = (active: boolean) =>
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
                <span className="text-[10px] text-dark-400 bg-dark-700 px-1.5 py-0.5 rounded-full">
                  {projects.length}
                </span>
              </div>
              <button
                onClick={onClose}
                className="p-1.5 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors"
                title="Close"
              >
                <X size={16} />
              </button>
            </div>

            {/* New project + import */}
            <div className="px-3 py-2 border-b border-dark-700/60 shrink-0 space-y-2">
              <button
                onClick={() => {
                  setCreateError(null);
                  setShowCreate(true);
                }}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded-lg transition-colors"
              >
                <Plus size={14} /> New Project
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-dark-700 hover:bg-dark-600 disabled:opacity-60 text-dark-200 text-sm rounded-lg transition-colors"
                title="Create a project from an exported configuration file (boards, agents, plugins)"
              >
                {importing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                {importing ? 'Importing...' : 'Import Project'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={handleImportFile}
              />
              {importError && (
                <div className="bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5 text-xs text-red-400">
                  {importError}
                </div>
              )}
            </div>

            {/* Project list */}
            <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
              {/* All Projects (clears the filter) */}
              <button
                onClick={() => pick('')}
                className={rowClass(projectFilter === '')}
                title="Show everything across all projects"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <LayoutGrid
                    size={14}
                    className={projectFilter === '' ? 'text-indigo-400' : 'text-dark-500'}
                  />
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
                      <FolderGit2
                        size={14}
                        className={active ? 'text-purple-400 shrink-0' : 'text-dark-500 shrink-0'}
                      />
                      <span className="truncate">{p.name}</span>
                    </button>
                    <div className="flex items-center gap-0.5 shrink-0">
                      {active && <Check size={14} className="text-indigo-400" />}
                      <button
                        onClick={e => handleExport(e, p)}
                        disabled={exportingId === p.id}
                        className="p-1 rounded text-dark-400 hover:text-dark-100 hover:bg-dark-700 transition-colors opacity-60 group-hover:opacity-100"
                        title="Export configuration (boards, agents, plugins — no credentials)"
                      >
                        {exportingId === p.id ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <Download size={13} />
                        )}
                      </button>
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          setSelectedProjectId(p.id);
                        }}
                        className="p-1 rounded text-dark-400 hover:text-dark-100 hover:bg-dark-700 transition-colors opacity-60 group-hover:opacity-100"
                        title="Manage project (boards, repos, storage, stats)"
                      >
                        <Settings size={13} />
                      </button>
                      <button
                        onClick={e => handleDelete(e, p)}
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

      {/* Import summary — the only place the server's warnings are surfaced */}
      {importResult && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-[90] p-4"
          onClick={() => setImportResult(null)}
        >
          <div
            className="bg-dark-800 border border-dark-600 rounded-xl w-full max-w-lg p-6 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-dark-100">
                Imported "{importResult.project.name}"
              </h3>
              <button
                onClick={() => setImportResult(null)}
                className="text-dark-400 hover:text-dark-100"
              >
                <X size={18} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 text-sm text-dark-300">
              <div>
                Boards: <span className="text-dark-100">{importResult.boards.length}</span>
              </div>
              <div>
                Agents: <span className="text-dark-100">{importResult.createdAgents}</span>
              </div>
              <div>
                Plugins:{' '}
                <span className="text-dark-100">
                  {importResult.createdPlugins} created, {importResult.reusedPlugins} reused
                </span>
              </div>
              <div>
                MCP servers:{' '}
                <span className="text-dark-100">
                  {importResult.createdMcpServers} created, {importResult.reusedMcpServers} reused
                </span>
              </div>
            </div>

            {importResult.warnings.length > 0 && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded px-3 py-2 space-y-1 max-h-60 overflow-y-auto">
                <p className="flex items-center gap-1.5 text-xs font-medium text-amber-300">
                  <AlertTriangle size={13} /> Credentials and missing references
                </p>
                <ul className="list-disc list-inside space-y-0.5 text-xs text-amber-200/90">
                  {importResult.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex justify-end pt-1">
              <button
                onClick={() => setImportResult(null)}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Project modal */}
      {showCreate && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-[90] p-4"
          onClick={() => !creating && setShowCreate(false)}
        >
          <div
            className="bg-dark-800 border border-dark-600 rounded-xl w-full max-w-md p-6 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-dark-100">New Project</h3>
              <button
                onClick={() => !creating && setShowCreate(false)}
                className="text-dark-400 hover:text-dark-100"
              >
                <X size={18} />
              </button>
            </div>
            <p className="text-xs text-dark-400">
              A project groups one or more boards. Each board can later be linked to git repos and
              cloud storage.
            </p>
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
