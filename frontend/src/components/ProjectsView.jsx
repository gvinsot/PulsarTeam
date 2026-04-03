import { useState, useMemo, useEffect } from 'react';
import { FolderGit2, Users, ListTodo, Clock, Search, Activity, BarChart3, ExternalLink, GitCommit, Plus, X, Loader2, Lock, Unlock } from 'lucide-react';
import ProjectDetailModal from './ProjectDetailModal';
import GitHubActivityModal from './GitHubActivityModal';
import api from '../api';

function GithubIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
    </svg>
  );
}

export default function ProjectsView({ agents = [], githubProjects = [], projectContexts = [], onRefresh }) {
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('name');
  const [selectedProject, setSelectedProject] = useState(null);
  const [activityTarget, setActivityTarget] = useState(null); // { owner, repo }
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [newProject, setNewProject] = useState({ name: '', description: '', isPrivate: false });

  const handleCreateProject = async () => {
    if (!newProject.name.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await api.createProject(newProject.name.trim(), newProject.description, newProject.isPrivate);
      setShowCreateModal(false);
      setNewProject({ name: '', description: '', isPrivate: false });
      if (onRefresh) onRefresh();
    } catch (err) {
      setCreateError(err.message || 'Failed to create project');
    } finally {
      setCreating(false);
    }
  };

  // Fetch tasks from API
  const [tasks, setTasks] = useState([]);
  useEffect(() => {
    api.getAllTasks().then(setTasks).catch(() => setTasks([]));
  }, [agents]);

  // Build a lookup of GitHub info by project name
  const githubLookup = useMemo(() => {
    const map = new Map();
    for (const gp of githubProjects) {
      map.set(gp.name, gp);
    }
    // Also check project contexts for manual github_url
    for (const ctx of projectContexts) {
      if (ctx.githubUrl && !map.has(ctx.name)) {
        // Parse owner/repo from URL
        const match = ctx.githubUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
        if (match) {
          map.set(ctx.name, {
            name: ctx.name,
            fullName: `${match[1]}/${match[2]}`,
            htmlUrl: ctx.githubUrl,
          });
        }
      }
    }
    return map;
  }, [githubProjects, projectContexts]);

  // Derive projects from agents + tasks
  const projects = useMemo(() => {
    const projectMap = new Map();

    for (const a of agents) {
      if (!a.project) continue;
      if (!projectMap.has(a.project)) {
        projectMap.set(a.project, { name: a.project, agents: [], tasks: [], stats: {} });
      }
      projectMap.get(a.project).agents.push(a);
    }

    for (const t of tasks) {
      if (!t.project) continue;
      if (!projectMap.has(t.project)) {
        projectMap.set(t.project, { name: t.project, agents: [], tasks: [], stats: {} });
      }
      projectMap.get(t.project).tasks.push(t);
    }

    for (const [, p] of projectMap) {
      const total = p.tasks.length;
      const done = p.tasks.filter(t => t.status === 'done').length;
      const active = p.tasks.filter(t => !['done', 'error', 'backlog'].includes(t.status || 'backlog')).length;
      const waiting = p.tasks.filter(t => ['error', 'backlog'].includes(t.status || 'backlog')).length;
      const bugs = p.tasks.filter(t => (t.type || 'bug') === 'bug').length;
      const features = p.tasks.filter(t => t.type === 'feature').length;
      p.stats = { total, done, active, inProgress: active, waiting, pending: waiting, bugs, features, completion: total ? Math.round((done / total) * 100) : 0 };
      // Attach GitHub info
      p.github = githubLookup.get(p.name) || null;
    }

    let result = Array.from(projectMap.values());
    if (search) {
      result = result.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));
    }
    if (sortBy === 'name') result.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === 'tasks') result.sort((a, b) => b.stats.total - a.stats.total);
    else if (sortBy === 'completion') result.sort((a, b) => b.stats.completion - a.stats.completion);
    return result;
  }, [agents, tasks, search, sortBy, githubLookup]);

  const handleOpenGitHub = (e, htmlUrl) => {
    e.stopPropagation();
    window.open(htmlUrl, '_blank', 'noopener,noreferrer');
  };

  const handleOpenActivity = (e, github) => {
    e.stopPropagation();
    if (!github?.fullName) return;
    const [owner, repo] = github.fullName.split('/');
    setActivityTarget({ owner, repo });
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <FolderGit2 size={20} className="text-purple-400" />
          <h2 className="text-lg font-semibold text-white">Projects</h2>
          <span className="text-xs text-dark-400 bg-dark-700 px-2 py-0.5 rounded-full">{projects.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-dark-400" />
            <input
              type="text"
              placeholder="Search projects..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="bg-dark-700 border border-dark-600 rounded pl-7 pr-3 py-1.5 text-sm text-white w-48"
            />
          </div>
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            className="bg-dark-700 border border-dark-600 rounded px-2 py-1.5 text-sm text-white"
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
      {selectedProject && (
        <ProjectDetailModal
          project={projects.find(p => p.name === selectedProject)}
          projectContext={projectContexts.find(c => c.name === selectedProject)}
          githubInfo={githubLookup.get(selectedProject) || null}
          onClose={() => setSelectedProject(null)}
          onRefresh={onRefresh}
        />
      )}

      {/* GitHub Activity Modal */}
      {activityTarget && (
        <GitHubActivityModal
          owner={activityTarget.owner}
          repo={activityTarget.repo}
          onClose={() => setActivityTarget(null)}
        />
      )}

      {/* Create Project Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => !creating && setShowCreateModal(false)}>
          <div className="bg-dark-800 border border-dark-600 rounded-xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">New Project</h3>
              <button onClick={() => !creating && setShowCreateModal(false)} className="text-dark-400 hover:text-white">
                <X size={18} />
              </button>
            </div>
            <p className="text-xs text-dark-400">Creates a new GitHub repository from the BoilerPlate template and adds it to your projects.</p>
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-dark-300 mb-1">Project Name *</label>
                <input
                  type="text"
                  value={newProject.name}
                  onChange={e => setNewProject(p => ({ ...p, name: e.target.value }))}
                  placeholder="my-new-project"
                  className="w-full bg-dark-700 border border-dark-600 rounded px-3 py-2 text-sm text-white placeholder-dark-500 focus:border-purple-500 focus:outline-none"
                  disabled={creating}
                  autoFocus
                  onKeyDown={e => e.key === 'Enter' && handleCreateProject()}
                />
                <p className="text-xs text-dark-500 mt-1">Letters, numbers, hyphens, dots and underscores only.</p>
              </div>
              <div>
                <label className="block text-sm text-dark-300 mb-1">Description</label>
                <input
                  type="text"
                  value={newProject.description}
                  onChange={e => setNewProject(p => ({ ...p, description: e.target.value }))}
                  placeholder="A short description..."
                  className="w-full bg-dark-700 border border-dark-600 rounded px-3 py-2 text-sm text-white placeholder-dark-500 focus:border-purple-500 focus:outline-none"
                  disabled={creating}
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-dark-300 cursor-pointer">
                <button
                  type="button"
                  onClick={() => setNewProject(p => ({ ...p, isPrivate: !p.isPrivate }))}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors ${
                    newProject.isPrivate
                      ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                      : 'bg-dark-700 text-dark-400 border border-dark-600'
                  }`}
                  disabled={creating}
                >
                  {newProject.isPrivate ? <Lock size={12} /> : <Unlock size={12} />}
                  {newProject.isPrivate ? 'Private' : 'Public'}
                </button>
              </label>
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
                className="px-4 py-2 text-sm text-dark-300 hover:text-white transition-colors"
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
      {projects.length === 0 && (
        <div className="text-center py-12 text-dark-400">
          <FolderGit2 size={48} className="mx-auto mb-3 opacity-30" />
          <p>No projects found</p>
          <p className="text-xs mt-1">Projects are derived from agent assignments and task projects</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects.map(p => (
          <div
            key={p.name}
            className="bg-dark-800 border border-dark-700 rounded-xl p-4 hover:border-purple-500/50 transition-colors cursor-pointer"
            onClick={() => setSelectedProject(p.name)}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-white truncate">{p.name}</h3>
              <div className="flex items-center gap-1">
                {/* GitHub buttons — only if we have GitHub info */}
                {p.github?.htmlUrl && (
                  <>
                    <button
                      onClick={(e) => handleOpenGitHub(e, p.github.htmlUrl)}
                      className="p-1 rounded hover:bg-dark-600 text-dark-400 hover:text-white transition-colors"
                      title="Open on GitHub"
                    >
                      <GithubIcon className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={(e) => handleOpenActivity(e, p.github)}
                      className="p-1 rounded hover:bg-dark-600 text-dark-400 hover:text-white transition-colors"
                      title="View GitHub activity"
                    >
                      <GitCommit size={14} />
                    </button>
                  </>
                )}
                <div className="p-1 rounded hover:bg-dark-600 text-dark-400" title="View details">
                  <BarChart3 size={14} />
                </div>
              </div>
            </div>

            {/* Progress bar */}
            <div className="w-full bg-dark-700 rounded-full h-1.5 mb-3">
              <div
                className="bg-green-500 h-1.5 rounded-full transition-all"
                style={{ width: `${p.stats.completion}%` }}
              />
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="flex items-center gap-1.5">
                <Users size={12} className="text-blue-400" />
                <span className="text-dark-300">{p.agents.length} agents</span>
              </div>
              <div className="flex items-center gap-1.5">
                <ListTodo size={12} className="text-purple-400" />
                <span className="text-dark-300">{p.stats.total} tasks</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-orange-400 text-xs">&#x1f41b;</span>
                <span className="text-dark-300">{p.stats.bugs} bugs</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-emerald-400 text-xs">&#x2728;</span>
                <span className="text-dark-300">{p.stats.features} features</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Activity size={12} className="text-yellow-400" />
                <span className="text-dark-300">{p.stats.active} active</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Clock size={12} className="text-green-400" />
                <span className="text-dark-300">{p.stats.completion}% done</span>
              </div>
            </div>

            {/* Agent avatars */}
            {p.agents.length > 0 && (
              <div className="flex items-center gap-1 mt-3 pt-3 border-t border-dark-700">
                {p.agents.slice(0, 5).map(a => (
                  <div
                    key={a.id || a.name}
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                      a.status === 'busy' ? 'bg-yellow-500/20 text-yellow-400' :
                      a.status === 'idle' ? 'bg-green-500/20 text-green-400' :
                      'bg-dark-600 text-dark-400'
                    }`}
                    title={`${a.name} (${a.status})`}
                  >
                    {(a.name || '?')[0]}
                  </div>
                ))}
                {p.agents.length > 5 && (
                  <span className="text-xs text-dark-400">+{p.agents.length - 5}</span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
