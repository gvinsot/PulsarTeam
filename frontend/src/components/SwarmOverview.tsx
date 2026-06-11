import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { Activity, Cpu, Clock, TrendingUp, Zap, AlertTriangle, FolderOpen, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../api';

function formatHours(ms) {
  if (!ms || ms <= 0) return '0h';
  const hours = ms / 3600000;
  if (hours < 10) return hours.toFixed(1) + 'h';
  return Math.round(hours) + 'h';
}

export default function SwarmOverview({ stats, agents }) {
  const [collapsed, setCollapsed] = useState(true);
  const [totalHoursMs, setTotalHoursMs] = useState(null);

  // Count unique active projects
  const activeProjects = new Set(agents.filter(a => a.project).map(a => a.project));

  useEffect(() => {
    api.getGlobalAgentTime(30)
      .then(data => setTotalHoursMs(data.totalMs || 0))
      .catch(() => setTotalHoursMs(0));
  }, []);

  return (
    <div className="border-b border-dark-800 bg-dark-900/30">
      <div className="max-w-[1800px] mx-auto px-4 sm:px-6 py-3">
        {/* Mobile toggle button */}
        <button
          onClick={() => setCollapsed(c => !c)}
          className="sm:hidden flex items-center justify-between w-full mb-2 text-sm text-dark-400 hover:text-dark-200 transition-colors"
        >
          <span className="flex items-center gap-2">
            <Activity className="w-3.5 h-3.5" />
            <span>Statistics</span>
            <span className="text-xs text-dark-500">
              ({stats.total} agents &middot; {stats.busy} active)
            </span>
          </span>
          {collapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
        </button>

        {/* Stats grid - hidden on mobile when collapsed, always visible on sm+ */}
        <div className={`${collapsed ? 'hidden' : 'grid'} sm:grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3`}>
          <StatCard
            icon={<Cpu className="w-4 h-4" />}
            label="Total Agents"
            value={stats.total}
            color="text-indigo-400"
            bgColor="bg-indigo-500/10"
          />
          <StatCard
            icon={<Activity className="w-4 h-4" />}
            label="Active"
            value={stats.busy}
            color="text-amber-400"
            bgColor="bg-amber-500/10"
          />
          <StatCard
            icon={<Zap className="w-4 h-4" />}
            label="Idle"
            value={stats.idle}
            color="text-emerald-400"
            bgColor="bg-emerald-500/10"
          />
          <StatCard
            icon={<AlertTriangle className="w-4 h-4" />}
            label="Errors"
            value={stats.errors}
            color="text-red-400"
            bgColor="bg-red-500/10"
          />
          <StatCard
            icon={<FolderOpen className="w-4 h-4" />}
            label="Projects"
            value={activeProjects.size}
            color="text-sky-400"
            bgColor="bg-sky-500/10"
            tooltip={activeProjects.size > 0 ? [...activeProjects].join(', ') : 'No projects assigned'}
          />
          <StatCard
            icon={<Clock className="w-4 h-4" />}
            label="Cumul. Hours"
            value={totalHoursMs !== null ? formatHours(totalHoursMs) : '...'}
            color="text-cyan-400"
            bgColor="bg-cyan-500/10"
            tooltip="Cumulative agent hours over the last 30 days"
          />
          <StatCard
            icon={<TrendingUp className="w-4 h-4" />}
            label="Tokens"
            value={formatNumber(stats.totalTokensIn + stats.totalTokensOut)}
            color="text-purple-400"
            bgColor="bg-purple-500/10"
          />
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, color, bgColor, tooltip }: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  color: string;
  bgColor: string;
  tooltip?: string;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-dark-800/50 border border-dark-700/50" title={tooltip || undefined}>
      <div className={`p-1.5 rounded-md ${bgColor}`}>
        <span className={color}>{icon}</span>
      </div>
      <div>
        <p className="text-xs text-dark-400">{label}</p>
        <p className={`text-lg font-bold ${color}`}>{value}</p>
      </div>
    </div>
  );
}

function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}
