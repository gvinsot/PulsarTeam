import { useState, useMemo, useCallback } from 'react';
import {
  Tag, Users, CheckSquare, Clock, AlertTriangle, Check, ChevronDown,
  Edit3, Save, X, BookOpen, ListChecks, Cpu, Zap, RefreshCw
} from 'lucide-react';
import { api } from '../api';

// ── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_COLORS = {
  backlog:     { dot: 'bg-purple-400',  text: 'text-purple-300',  bg: 'bg-purple-500/10' },
  pending:     { dot: 'bg-slate-400',   text: 'text-slate-300',   bg: 'bg-slate-500/10' },
  in_progress: { dot: 'bg-amber-400',   text: 'text-amber-300',   bg: 'bg-amber-500/10' },
  done:        { dot: 'bg-emerald-400', text: 'text-emerald-300', bg: 'bg-emerald-500/10' },
  error:       { dot: 'bg-red-400',     text: 'text-red-300',     bg: 'bg-red-500/10' },
};

const STATUS_LABELS = {
  backlog: 'Backlog', pending: 'To Do', in_progress: 'In Progress', done: 'Done', error: 'Error'
};

function formatNumber(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ── ProjectContextEditor ─────────────────────────────────────────────────────

function ProjectContextEditor({ projectName, context, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(context?.description || '');
  const [rules, setRules] = useState(context?.rules || '');
  const [saving, setSaving] = useState(false);

  const handleEdit = () => {
    setDescription(context?.description || '');
    setRules(context?.rules || '');
    setEditing(true);
  };

  const handleCancel = () => {
    setEditing(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.saveProjectContext(projectName, description, rules);
      await onSaved();
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const hasContent = context?.description || context?.rules;

  if (!editing) {
    return (
      <div className="mt-4 border-t border-dark-700/50 pt-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold text-dark-400 uppercase tracking-wide flex items-center gap-1.5">
            <BookOpen className="w-3 h-3" />
            Project Context
          </span>
          <button
            onClick={handleEdit}
            className="flex items-center gap-1 text-xs text-dark-500 hover:text-indigo-400 transition-colors"
          >
            <Edit3 className="w-3 h-3" />
            {hasContent ? 'Edit' : 'Add context'}
          </button>
        </div>
        {hasContent ? (
          <div className="space-y-3">
            {context.description && (
              <div>
                <p className="text-xs text-dark-500 mb-1">Objective</p>
                <p className="text-xs text-dark-300 leading-relaxed whitespace-pre-wrap">{context.description}</p>
              </div>
            )}
            {context.rules && (
              <div>
                <p className="text-xs text-dark-500 mb-1 flex items-center gap-1">
                  <ListChecks className="w-3 h-3" />Rules
                </p>
                <p className="text-xs text-dark-300 leading-relaxed whitespace-pre-wrap">{context.rules}</p>
              </div>
            )}
          </div>
        ) : (
          <p className="text-xs text-dark-600 italic">No context defined yet. Add an objective and rules for this project.</p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-4 border-t border-dark-700/50 pt-4 space-y-3">
      <span className="text-xs font-semibold text-dark-400 uppercase tracking-wide flex items-center gap-1.5">
        <BookOpen className="w-3 h-3" />
        Project Context
      </span>
      <div>
        <label className="block text-xs text-dark-500 mb-1">Objective / Description</label>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          rows={3}
          placeholder="What is this project trying to achieve?"
          className="w-full px-3 py-2 bg-dark-800 border border-dark-700 rounded-lg text-xs text-dark-200
            placeholder-dark-600 focus:outline-none focus:border-indigo-500 resize-none transition-colors"
        />
      </div>
      <div>
        <label className="block text-xs text-dark-500 mb-1 flex items-center gap-1">
          <ListChecks className="w-3 h-3" />Rules &amp; guidelines
        </label>
        <textarea
          value={rules}
          onChange={e => setRules(e.target.value)}
          rows={4}
          placeholder="Rules agents should follow when working on this project..."
          className="w-full px-3 py-2 bg-dark-800 border border-dark-700 rounded-lg text-xs text-dark-200
            placeholder-dark-600 focus:outline-none focus:border-indigo-500 resize-none transition-colors"
        />
      </div>
      <div className="flex justify-end gap-2">
        <button
          onClick={handleCancel}
          className="px-3 py-1.5 text-xs text-dark-400 hover:text-dark-200 bg-dark-800
            border border-dark-700 hover:border-dark-500 rounded-lg transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white
            bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 rounded-lg transition-colors"
        >
          <Save className="w-3 h-3" />
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ── ProjectCard ──────────────────────────────────────────────────────────────

function ProjectCard({ projectName, agents, tasks, context, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [indexStatus, setIndexStatus] = useState(null); // null | 'ok' | 'error'

  const handleReindex = async () => {
    setIndexing(true);
    setIndexStatus(null);
    try {
      await api.indexProject(projectName);
      setIndexStatus('ok');
    } catch {
      setIndexStatus('error');
    } finally {
      setIndexing(false);
      setTimeout(() => setIndexStatus(null), 3000);
    }
  };

  const projectAgents = useMemo(
    () => agents.filter(a => a.project === projectName),
    [agents, projectName]
  );

  const taskCounts = useMemo(() => {
    const counts = { backlog: 0, pending: 0, in_progress: 0, done: 0, error: 0, total: 0 };
    tasks.forEach(t => {
      const s = t.status || 'pending';
      if (s in counts) counts[s]++;
      counts.total++;
    });
    return counts;
  }, [tasks]);

  const tokens = useMemo(() => {
    const tokensIn = projectAgents.reduce((s, a) => s + (a.metrics?.totalTokensIn || 0), 0);
    const tokensOut = projectAgents.reduce((s, a) => s + (a.metrics?.totalTokensOut || 0), 0);
    return { in: tokensIn, out: tokensOut, total: tokensIn + tokensOut };
  }, [projectAgents]);

  const completionPct = taskCounts.total > 0
    ? Math.round((taskCounts.done / taskCounts.total) * 100)
    : 0;

  return (
    <div className="bg-dark-800/60 border border-dark-700/50 rounded-xl overflow-hidden hover:border-dark-600 transition-colors">
      {/* Header */}
      <div className="px-5 py-4">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-violet-500/15 border border-violet-500/20 flex items-center justify-center flex-shrink-0">
              <Tag className="w-4 h-4 text-violet-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-dark-100">{projectName}</h3>
              {context?.description && (
                <p className="text-xs text-dark-400 mt-0.5 line-clamp-1">{context.description}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0 mt-0.5">
            <button
              onClick={handleReindex}
              disabled={indexing}
              title="Re-index project locally"
              className={`p-1 rounded transition-colors ${
                indexStatus === 'ok' ? 'text-emerald-400' :
                indexStatus === 'error' ? 'text-red-400' :
                'text-dark-500 hover:text-indigo-400'
              }`}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${indexing ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={() => setExpanded(e => !e)}
              className="p-1 text-dark-500 hover:text-dark-300 transition-colors"
            >
              <ChevronDown className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-dark-800 rounded-lg px-3 py-2 border border-dark-700/50">
            <div className="flex items-center gap-1.5 mb-0.5">
              <Users className="w-3 h-3 text-indigo-400" />
              <span className="text-xs text-dark-400">Agents</span>
            </div>
            <span className="text-lg font-bold text-dark-100">{projectAgents.length}</span>
          </div>
          <div className="bg-dark-800 rounded-lg px-3 py-2 border border-dark-700/50">
            <div className="flex items-center gap-1.5 mb-0.5">
              <CheckSquare className="w-3 h-3 text-emerald-400" />
              <span className="text-xs text-dark-400">Tasks</span>
            </div>
            <span className="text-lg font-bold text-dark-100">{taskCounts.total}</span>
          </div>
          <div className="bg-dark-800 rounded-lg px-3 py-2 border border-dark-700/50">
            <div className="flex items-center gap-1.5 mb-0.5">
              <Zap className="w-3 h-3 text-amber-400" />
              <span className="text-xs text-dark-400">Tokens</span>
            </div>
            <span className="text-lg font-bold text-dark-100">{formatNumber(tokens.total)}</span>
          </div>
        </div>

        {/* Task status breakdown */}
        {taskCounts.total > 0 && (
          <div>
            {/* Progress bar */}
            <div className="flex items-center gap-2 mb-2">
              <div className="flex-1 h-1.5 bg-dark-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                  style={{ width: `${completionPct}%` }}
                />
              </div>
              <span className="text-xs text-dark-400 flex-shrink-0">{completionPct}%</span>
            </div>
            {/* Status pills */}
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(STATUS_LABELS).map(([status, label]) => {
                const count = taskCounts[status];
                if (!count) return null;
                const c = STATUS_COLORS[status];
                return (
                  <span key={status}
                    className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${c.text} ${c.bg}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
                    {count} {label}
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Expanded section */}
      {expanded && (
        <div className="border-t border-dark-700/50 px-5 pb-5">
          {/* Agents list */}
          {projectAgents.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-semibold text-dark-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <Users className="w-3 h-3" />Agents
              </p>
              <div className="space-y-1.5">
                {projectAgents.map(a => (
                  <div key={a.id} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                        style={{ background: a.status === 'busy' ? '#f59e0b' : a.status === 'error' ? '#ef4444' : '#22c55e' }}
                      />
                      <span className="text-xs text-dark-300">{a.name}</span>
                      <span className="text-xs text-dark-500 capitalize">{a.status}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-dark-500">
                      <span className="flex items-center gap-1">
                        <Cpu className="w-3 h-3" />
                        {formatNumber((a.metrics?.totalTokensIn || 0) + (a.metrics?.totalTokensOut || 0))}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Context editor */}
          <ProjectContextEditor
            projectName={projectName}
            context={context}
            onSaved={onRefresh}
          />
        </div>
      )}
    </div>
  );
}

// ── ProjectsView ─────────────────────────────────────────────────────────────

export default function ProjectsView({ agents, projectContexts, onRefresh }) {
  // Derive all project names from agents and their tasks
  const allProjectNames = useMemo(() => {
    const names = new Set();
    agents.forEach(a => {
      if (a.project) names.add(a.project);
      (a.todoList || []).forEach(t => { if (t.project) names.add(t.project); });
    });
    return Array.from(names).sort();
  }, [agents]);

  // All tasks across all agents
  const allTasks = useMemo(() =>
    agents.flatMap(a => (a.todoList || []).map(t => ({ ...t, agentId: a.id }))),
    [agents]
  );

  const contextByName = useMemo(() => {
    const map = {};
    projectContexts.forEach(c => { map[c.name] = c; });
    return map;
  }, [projectContexts]);

  const totalTokens = useMemo(() =>
    agents.reduce((s, a) => s + (a.metrics?.totalTokensIn || 0) + (a.metrics?.totalTokensOut || 0), 0),
    [agents]
  );

  const totalTasks = allTasks.length;
  const doneTasks = allTasks.filter(t => t.status === 'done').length;

  if (allProjectNames.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-12">
        <div className="text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-dark-800 flex items-center justify-center">
            <Tag className="w-8 h-8 text-dark-500" />
          </div>
          <h3 className="text-dark-300 font-medium mb-1">No projects yet</h3>
          <p className="text-dark-500 text-sm">Assign agents or tasks to a project to see them here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-4 px-6 py-3 border-b border-dark-700 bg-dark-900/30">
        <div className="text-sm font-semibold text-dark-200">
          {allProjectNames.length} project{allProjectNames.length !== 1 ? 's' : ''}
        </div>
        <div className="flex items-center gap-4 ml-auto text-xs text-dark-500">
          <span className="flex items-center gap-1.5">
            <CheckSquare className="w-3.5 h-3.5 text-emerald-400" />
            {doneTasks}/{totalTasks} tasks done
          </span>
          <span className="flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-amber-400" />
            {formatNumber(totalTokens)} total tokens
          </span>
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 max-w-[1800px]">
          {allProjectNames.map(name => (
            <ProjectCard
              key={name}
              projectName={name}
              agents={agents}
              tasks={allTasks.filter(t => t.project === name)}
              context={contextByName[name] || null}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
