import { useEffect, useState } from 'react';
import {
  X, Users, ListTodo, Activity, Clock, CheckCircle, AlertCircle,
  FolderGit2, Bug, Sparkles, BarChart3, FileText, Save, Loader2,
  ExternalLink, GitCommit
} from 'lucide-react';
import ProjectStats from './ProjectStats';
import GitHubActivityModal from './GitHubActivityModal';
import { api } from '../api';

function GithubIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
    </svg>
  );
}

const TABS = [
  { id: 'overview',   label: 'Overview',    icon: FolderGit2 },
  { id: 'tasks',      label: 'Tasks',       icon: ListTodo },
  { id: 'context',    label: 'Context',     icon: FileText },
  { id: 'statistics', label: 'Statistics',  icon: BarChart3 },
];

export default function ProjectDetailModal({ project, projectContext, githubInfo, onClose, onRefresh }) {
  const [activeTab, setActiveTab] = useState('overview');

  // Close on Escape key
  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Prevent body scroll while modal is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // Project context editing state
  const [ctxDescription, setCtxDescription] = useState(projectContext?.description || '');
  const [ctxRules, setCtxRules] = useState(projectContext?.rules || '');
  const [ctxGithubUrl, setCtxGithubUrl] = useState(projectContext?.githubUrl || '');
  const [ctxSaving, setCtxSaving] = useState(false);
  const [ctxSaved, setCtxSaved] = useState(false);
  const [showActivity, setShowActivity] = useState(false);

  useEffect(() => {
    setCtxDescription(projectContext?.description || '');
    setCtxRules(projectContext?.rules || '');
    setCtxGithubUrl(projectContext?.githubUrl || '');
  }, [projectContext]);

  // Resolve GitHub URL: from starred repos or from project context
  const resolvedGithubUrl = githubInfo?.htmlUrl || ctxGithubUrl || '';
  const resolvedFullName = githubInfo?.fullName || (() => {
    const m = resolvedGithubUrl.match(/github\.com\/([^/]+\/[^/]+)/);
    return m ? m[1].replace(/\.git$/, '') : '';
  })();

  const handleSaveContext = async () => {
    setCtxSaving(true);
    setCtxSaved(false);
    try {
      await api.saveProjectContext(project.name, ctxDescription, ctxRules, ctxGithubUrl);
      setCtxSaved(true);
      if (onRefresh) onRefresh();
      setTimeout(() => setCtxSaved(false), 2000);
    } catch (err) {
      console.error('Failed to save project context:', err);
    } finally {
      setCtxSaving(false);
    }
  };

  if (!project) return null;

  const { name, agents, tasks, stats } = project;

  const INACTIVE_SET = new Set(['done', 'error', 'backlog']);
  const tasksByStatus = {
    active: tasks.filter(t => !INACTIVE_SET.has(t.status || 'backlog')),
    backlog: tasks.filter(t => t.status === 'backlog'),
    done: tasks.filter(t => t.status === 'done'),
    error: tasks.filter(t => t.status === 'error'),
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-dark-900 border border-dark-700 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: '90vw', height: '90vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-dark-700 shrink-0">
          <div className="flex items-center gap-3">
            <FolderGit2 size={22} className="text-purple-400" />
            <h2 className="text-xl font-bold text-dark-100">{name}</h2>
            <span className="text-xs text-dark-400 bg-dark-700 px-2 py-0.5 rounded-full">
              {stats.completion}% complete
            </span>
          </div>
          <div className="flex items-center gap-2">
            {/* GitHub buttons */}
            {resolvedGithubUrl && (
              <>
                <a
                  href={resolvedGithubUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-dark-300 hover:text-dark-100 bg-dark-800 hover:bg-dark-700 border border-dark-600 rounded-lg transition-colors"
                  title="Open on GitHub"
                >
                  <GithubIcon className="w-4 h-4" />
                  <span className="hidden sm:inline">GitHub</span>
                  <ExternalLink size={12} />
                </a>
                {resolvedFullName && (
                  <button
                    onClick={() => setShowActivity(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-dark-300 hover:text-dark-100 bg-dark-800 hover:bg-dark-700 border border-dark-600 rounded-lg transition-colors"
                    title="View GitHub activity"
                  >
                    <GitCommit size={14} />
                    <span className="hidden sm:inline">Activity</span>
                  </button>
                )}
              </>
            )}
            <button
              onClick={onClose}
              className="p-2 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Tab Bar */}
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
                {tab.id === 'tasks' && stats.total > 0 && (
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                    isActive ? 'bg-purple-500/20 text-purple-400' : 'bg-dark-700 text-dark-500'
                  }`}>
                    {stats.total}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Tab Content -- scrollable */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'overview' && (
            <OverviewTab agents={agents} tasks={tasks} stats={stats} />
          )}
          {activeTab === 'tasks' && (
            <TasksTab tasks={tasks} tasksByStatus={tasksByStatus} />
          )}
          {activeTab === 'context' && (
            <ContextTab
              projectContext={projectContext}
              githubInfo={githubInfo}
              ctxDescription={ctxDescription}
              setCtxDescription={setCtxDescription}
              ctxRules={ctxRules}
              setCtxRules={setCtxRules}
              ctxGithubUrl={ctxGithubUrl}
              setCtxGithubUrl={setCtxGithubUrl}
              ctxSaving={ctxSaving}
              ctxSaved={ctxSaved}
              onSave={handleSaveContext}
            />
          )}
          {activeTab === 'statistics' && (
            <StatisticsTab projectName={name} />
          )}
        </div>
      </div>

      {/* GitHub Activity sub-modal */}
      {showActivity && resolvedFullName && (
        <GitHubActivityModal
          owner={resolvedFullName.split('/')[0]}
          repo={resolvedFullName.split('/')[1]}
          onClose={() => setShowActivity(false)}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Tab: Overview
   ═══════════════════════════════════════════════════════════════════════════ */
function OverviewTab({ agents, tasks, stats }) {
  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <SummaryCard icon={<Users size={16} />} label="Agents" value={agents.length} color="text-blue-400" />
        <SummaryCard icon={<ListTodo size={16} />} label="Total Tasks" value={stats.total} color="text-purple-400" />
        <SummaryCard icon={<Activity size={16} />} label="In Progress" value={stats.inProgress} color="text-yellow-400" />
        <SummaryCard icon={<Clock size={16} />} label="Pending" value={stats.pending} color="text-orange-400" />
        <SummaryCard icon={<Bug size={16} />} label="Bugs" value={stats.bugs} color="text-red-400" />
        <SummaryCard icon={<Sparkles size={16} />} label="Features" value={stats.features} color="text-emerald-400" />
      </div>

      {/* Progress bar */}
      <div>
        <div className="flex items-center justify-between text-xs text-dark-300 mb-1.5">
          <span>Progress</span>
          <span>{stats.done} / {stats.total} tasks done</span>
        </div>
        <div className="w-full bg-dark-700 rounded-full h-2.5">
          <div
            className="bg-green-500 h-2.5 rounded-full transition-all"
            style={{ width: `${stats.completion}%` }}
          />
        </div>
      </div>

      {/* Agents Section */}
      <Section title="Assigned Agents" icon={<Users size={16} className="text-blue-400" />}>
        {agents.length === 0 ? (
          <p className="text-dark-500 text-sm">No agents assigned to this project</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {agents.map(a => (
              <div
                key={a.id || a.name}
                className="flex items-center gap-3 p-3 bg-dark-800 border border-dark-700 rounded-lg"
              >
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                    a.status === 'busy' ? 'bg-yellow-500/20 text-yellow-400' :
                    a.status === 'idle' ? 'bg-green-500/20 text-green-400' :
                    a.status === 'error' ? 'bg-red-500/20 text-red-400' :
                    'bg-dark-600 text-dark-400'
                  }`}
                >
                  {(a.name || '?')[0]}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-dark-100 truncate">{a.name}</p>
                  <p className="text-xs text-dark-400">{a.role || 'worker'} &middot; {a.status}</p>
                </div>
                <StatusDot status={a.status} />
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Tab: Tasks
   ═══════════════════════════════════════════════════════════════════════════ */
function TasksTab({ tasks, tasksByStatus }) {
  if (tasks.length === 0) {
    return <p className="text-dark-500 text-sm">No tasks in this project</p>;
  }

  return (
    <div className="space-y-4">
      {tasksByStatus.active.length > 0 && (
        <TaskGroup label="Active" tasks={tasksByStatus.active} icon={<Activity size={14} className="text-yellow-400" />} />
      )}
      {tasksByStatus.error.length > 0 && (
        <TaskGroup label="Error" tasks={tasksByStatus.error} icon={<AlertCircle size={14} className="text-red-400" />} />
      )}
      {tasksByStatus.backlog.length > 0 && (
        <TaskGroup label="Backlog" tasks={tasksByStatus.backlog} icon={<ListTodo size={14} className="text-dark-400" />} />
      )}
      {tasksByStatus.done.length > 0 && (
        <TaskGroup label="Done" tasks={tasksByStatus.done} icon={<CheckCircle size={14} className="text-green-400" />} defaultCollapsed />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Tab: Context
   ═══════════════════════════════════════════════════════════════════════════ */
function ContextTab({
  projectContext, githubInfo,
  ctxDescription, setCtxDescription,
  ctxRules, setCtxRules,
  ctxGithubUrl, setCtxGithubUrl,
  ctxSaving, ctxSaved, onSave,
}) {
  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <label className="block text-xs text-dark-400 mb-1">Description</label>
        <textarea
          value={ctxDescription}
          onChange={e => setCtxDescription(e.target.value)}
          placeholder="Describe this project: tech stack, architecture, key patterns..."
          rows={3}
          className="w-full bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-dark-100 placeholder-dark-500 resize-y focus:outline-none focus:border-cyan-500/50"
        />
      </div>
      <div>
        <label className="block text-xs text-dark-400 mb-1">Rules &amp; Instructions</label>
        <textarea
          value={ctxRules}
          onChange={e => setCtxRules(e.target.value)}
          placeholder="Define rules agents must follow when working on this project..."
          rows={4}
          className="w-full bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-dark-100 placeholder-dark-500 resize-y focus:outline-none focus:border-cyan-500/50"
        />
      </div>
      <div>
        <label className="block text-xs text-dark-400 mb-1">
          <span className="flex items-center gap-1">
            <GithubIcon className="w-3 h-3" />
            GitHub URL
            {githubInfo?.htmlUrl && (
              <span className="text-green-400 ml-1">(auto-detected)</span>
            )}
          </span>
        </label>
        {githubInfo?.htmlUrl ? (
          <div className="flex items-center gap-2 text-sm text-dark-300">
            <a
              href={githubInfo.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-purple-400 hover:text-purple-300 underline"
            >
              {githubInfo.fullName}
            </a>
          </div>
        ) : (
          <input
            type="url"
            value={ctxGithubUrl}
            onChange={e => setCtxGithubUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            className="w-full bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-cyan-500/50"
          />
        )}
      </div>
      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={onSave}
          disabled={ctxSaving}
          className="flex items-center gap-2 px-4 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
        >
          {ctxSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {ctxSaving ? 'Saving...' : 'Save Context'}
        </button>
        {ctxSaved && (
          <span className="text-xs text-green-400 flex items-center gap-1">
            <CheckCircle size={12} /> Saved
          </span>
        )}
        {projectContext?.updatedAt && (
          <span className="text-xs text-dark-500 ml-auto">
            Last updated: {new Date(projectContext.updatedAt).toLocaleString()}
          </span>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Tab: Statistics
   ═══════════════════════════════════════════════════════════════════════════ */
function StatisticsTab({ projectName }) {
  return <ProjectStats projectName={projectName} onClose={() => {}} embedded />;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Shared sub-components
   ═══════════════════════════════════════════════════════════════════════════ */
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

function StatusDot({ status }) {
  const cls = status === 'busy' ? 'bg-yellow-400 animate-pulse' :
              status === 'idle' ? 'bg-green-400' :
              status === 'error' ? 'bg-red-400' :
              'bg-dark-500';
  return <span className={`w-2 h-2 rounded-full ${cls}`} />;
}

function TaskGroup({ label, tasks, icon, defaultCollapsed = false }) {
  return (
    <details open={!defaultCollapsed}>
      <summary className="flex items-center gap-2 cursor-pointer select-none text-sm text-dark-300 hover:text-dark-100 transition-colors mb-2">
        {icon}
        <span className="font-medium">{label}</span>
        <span className="text-xs text-dark-500">({tasks.length})</span>
      </summary>
      <div className="space-y-1.5 ml-5">
        {tasks.map(t => (
          <div key={t.id || t.text} className="flex items-center gap-3 p-2 bg-dark-800/60 border border-dark-700/50 rounded-lg">
            <div className="flex-1 min-w-0">
              <p className="text-sm text-dark-100 truncate">{t.text}</p>
              <p className="text-xs text-dark-500">
                {t.agentName || 'Unassigned'}
                {t.type && <span className="ml-2 capitalize">&middot; {t.type}</span>}
              </p>
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}
