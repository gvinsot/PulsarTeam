import { useEffect } from 'react';
import {
  X, Users, ListTodo, Activity, Clock, CheckCircle, AlertCircle,
  FolderGit2, Bug, Sparkles, BarChart3
} from 'lucide-react';
import ProjectStats from './ProjectStats';

export default function ProjectDetailModal({ project, onClose }) {
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
            <h2 className="text-xl font-bold text-white">{name}</h2>
            <span className="text-xs text-dark-400 bg-dark-700 px-2 py-0.5 rounded-full">
              {stats.completion}% complete
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-dark-400 hover:text-white hover:bg-dark-700 rounded-lg transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
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
                      <p className="text-sm font-medium text-white truncate">{a.name}</p>
                      <p className="text-xs text-dark-400">{a.role || 'worker'} &middot; {a.status}</p>
                    </div>
                    <StatusDot status={a.status} />
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Tasks Section */}
          <Section title="Tasks" icon={<ListTodo size={16} className="text-purple-400" />}>
            {tasks.length === 0 ? (
              <p className="text-dark-500 text-sm">No tasks in this project</p>
            ) : (
              <div className="space-y-4">
                {/* Active */}
                {tasksByStatus.active.length > 0 && (
                  <TaskGroup label="Active" tasks={tasksByStatus.active} icon={<Activity size={14} className="text-yellow-400" />} />
                )}
                {/* Error */}
                {tasksByStatus.error.length > 0 && (
                  <TaskGroup label="Error" tasks={tasksByStatus.error} icon={<AlertCircle size={14} className="text-red-400" />} />
                )}
                {/* Backlog */}
                {tasksByStatus.backlog.length > 0 && (
                  <TaskGroup label="Backlog" tasks={tasksByStatus.backlog} icon={<ListTodo size={14} className="text-dark-400" />} />
                )}
                {/* Done */}
                {tasksByStatus.done.length > 0 && (
                  <TaskGroup label="Done" tasks={tasksByStatus.done} icon={<CheckCircle size={14} className="text-green-400" />} defaultCollapsed />
                )}
              </div>
            )}
          </Section>

          {/* Statistics (charts) */}
          <Section title="Statistics" icon={<BarChart3 size={16} className="text-purple-400" />}>
            <ProjectStats projectName={name} onClose={() => {}} embedded />
          </Section>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ icon, label, value, color }) {
  return (
    <div className="bg-dark-800 border border-dark-700 rounded-lg px-4 py-3">
      <div className={`flex items-center gap-1.5 ${color} mb-1`}>
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p className="text-lg font-bold text-white">{value}</p>
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
      <summary className="flex items-center gap-2 cursor-pointer select-none text-sm text-dark-300 hover:text-white transition-colors mb-2">
        {icon}
        <span className="font-medium">{label}</span>
        <span className="text-xs text-dark-500">({tasks.length})</span>
      </summary>
      <div className="space-y-1.5 ml-5">
        {tasks.map(t => (
          <div key={t.id || t.text} className="flex items-center gap-3 p-2 bg-dark-800/60 border border-dark-700/50 rounded-lg">
            <div className="flex-1 min-w-0">
              <p className="text-sm text-white truncate">{t.text}</p>
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
