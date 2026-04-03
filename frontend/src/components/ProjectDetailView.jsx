import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, GitBranch, GitCommit, Users, CheckCircle,
  Clock, AlertCircle, Activity, ExternalLink, Folder,
  Circle, Shield, Tag
} from 'lucide-react';
import api from '../api';

export default function ProjectDetailView() {
  const { name } = useParams();
  const navigate = useNavigate();

  const [project, setProject] = useState(null);
  const [agents, setAgents] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [branches, setBranches] = useState([]);
  const [commits, setCommits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchAll() {
      setLoading(true);
      setError(null);
      try {
        const [projRes, agentsRes, tasksRes, branchesRes, commitsRes] = await Promise.all([
          api.get(`/api/projects/${encodeURIComponent(name)}`),
          api.get(`/api/projects/${encodeURIComponent(name)}/agents`),
          api.get(`/api/projects/${encodeURIComponent(name)}/tasks`),
          api.get(`/api/projects/${encodeURIComponent(name)}/branches`),
          api.get(`/api/projects/${encodeURIComponent(name)}/commits`),
        ]);
        setProject(projRes.data?.project || null);
        setAgents(agentsRes.data?.agents || []);
        setTasks(tasksRes.data?.tasks || []);
        setBranches(branchesRes.data?.branches || []);
        setCommits(commitsRes.data?.commits || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchAll();
  }, [name]);

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="p-6">
        <button onClick={() => navigate('/projects')} className="flex items-center gap-2 text-gray-400 hover:text-white mb-4">
          <ArrowLeft size={16} /> Back to Projects
        </button>
        <p className="text-red-400">{error || 'Project not found'}</p>
      </div>
    );
  }

  // Task stats
  const INACTIVE = new Set(['done', 'error', 'backlog']);
  const taskStats = {
    total: tasks.length,
    done: tasks.filter(t => t.status === 'done').length,
    active: tasks.filter(t => !INACTIVE.has(t.status || 'backlog')).length,
    waiting: tasks.filter(t => INACTIVE.has(t.status || 'backlog') && t.status !== 'done').length,
  };

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full">
      {/* Header */}
      <div className="flex items-center gap-4">
        <button onClick={() => navigate('/projects')} className="text-gray-400 hover:text-white">
          <ArrowLeft size={20} />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-white">{project.name}</h1>
          {project.repoUrl && (
            <a
              href={project.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1 mt-1"
            >
              <Folder size={14} /> {project.repoUrl}
              <ExternalLink size={12} />
            </a>
          )}
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard icon={<CheckCircle size={18} />} label="Completed" value={taskStats.done} color="text-green-400" />
        <StatCard icon={<Activity size={18} />} label="Active" value={taskStats.active} color="text-blue-400" />
        <StatCard icon={<Clock size={18} />} label="Pending" value={taskStats.pending} color="text-yellow-400" />
        <StatCard icon={<Users size={18} />} label="Agents" value={agents.length} color="text-purple-400" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Assigned Agents */}
        <Section title="Assigned Agents" icon={<Users size={18} />}>
          {agents.length === 0 ? (
            <p className="text-gray-500 text-sm">No agents assigned</p>
          ) : (
            <div className="space-y-2">
              {agents.map(agent => (
                <div
                  key={agent.id}
                  onClick={() => navigate(`/agent/${agent.id}`)}
                  className="flex items-center justify-between p-3 bg-gray-700/50 rounded-lg hover:bg-gray-700 cursor-pointer transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <StatusDot status={agent.status} />
                    <div>
                      <p className="text-sm font-medium text-white">{agent.name}</p>
                      <p className="text-xs text-gray-400">{agent.role || 'worker'} &middot; {agent.provider}/{agent.model}</p>
                    </div>
                  </div>
                  <span className="text-xs text-gray-500">
                    {agent.tasks?.active ?? 0} active
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Task Overview */}
        <Section title="Task Overview" icon={<CheckCircle size={18} />}>
          {tasks.length === 0 ? (
            <p className="text-gray-500 text-sm">No tasks yet</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {tasks.slice(0, 15).map(task => (
                <div key={task.id} className="flex items-center gap-3 p-2 rounded-lg bg-gray-700/30">
                  <TaskStatusIcon status={task.status} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">{task.text}</p>
                    <p className="text-xs text-gray-500">{task.agentName} &middot; {task.status}</p>
                  </div>
                </div>
              ))}
              {tasks.length > 15 && (
                <p className="text-xs text-gray-500 text-center pt-1">
                  +{tasks.length - 15} more tasks
                </p>
              )}
            </div>
          )}
        </Section>

        {/* Branches */}
        <Section title="Branches" icon={<GitBranch size={18} />}>
          {branches.length === 0 ? (
            <p className="text-gray-500 text-sm">No branches found</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {branches.map(branch => (
                <div key={branch.name} className="flex items-center justify-between p-2 rounded-lg bg-gray-700/30">
                  <div className="flex items-center gap-2">
                    <GitBranch size={14} className="text-gray-400" />
                    <span className="text-sm text-white font-mono">{branch.name}</span>
                    {branch.protected && <Shield size={12} className="text-yellow-400" title="Protected" />}
                  </div>
                  <span className="text-xs text-gray-500 font-mono">{branch.sha?.slice(0, 7)}</span>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Recent Commits */}
        <Section title="Recent Commits" icon={<GitCommit size={18} />}>
          {commits.length === 0 ? (
            <p className="text-gray-500 text-sm">No commits found</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {commits.map(commit => (
                <a
                  key={commit.sha}
                  href={commit.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block p-2 rounded-lg bg-gray-700/30 hover:bg-gray-700/50 transition-colors"
                >
                  <div className="flex items-start gap-2">
                    <Tag size={14} className="text-gray-400 mt-0.5 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm text-white truncate">{commit.message?.split('\n')[0]}</p>
                      <p className="text-xs text-gray-500">
                        {commit.author} &middot; {commit.date ? new Date(commit.date).toLocaleDateString() : ''}
                        <span className="ml-2 font-mono">{commit.sha?.slice(0, 7)}</span>
                      </p>
                    </div>
                  </div>
                </a>
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

// ── Helper components ─────────────────────────────────────────────────────────

function StatCard({ icon, label, value, color }) {
  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <div className={`flex items-center gap-2 ${color} mb-1`}>
        {icon}
        <span className="text-sm">{label}</span>
      </div>
      <p className="text-2xl font-bold text-white">{value}</p>
    </div>
  );
}

function Section({ title, icon, children }) {
  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2 mb-3">
        {icon} {title}
      </h3>
      {children}
    </div>
  );
}

function StatusDot({ status }) {
  const colors = {
    idle: 'bg-gray-400',
    busy: 'bg-blue-400 animate-pulse',
    error: 'bg-red-400',
    offline: 'bg-gray-600',
  };
  return <Circle size={8} className={`${colors[status] || 'bg-gray-400'} fill-current`} />;
}

function TaskStatusIcon({ status }) {
  if (status === 'done') return <CheckCircle size={14} className="text-green-400" />;
  if (!['done', 'error', 'backlog'].includes(status)) return <Activity size={14} className="text-blue-400 animate-pulse" />;
  if (status === 'error') return <AlertCircle size={14} className="text-red-400" />;
  return <Clock size={14} className="text-gray-400" />;
}