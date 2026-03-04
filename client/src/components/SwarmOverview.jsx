import { Activity, Cpu, MessageSquare, TrendingUp, Zap, AlertTriangle, FolderOpen } from 'lucide-react';

export default function SwarmOverview({ stats, agents }) {
  // Count unique active projects
  const activeProjects = new Set(agents.filter(a => a.project).map(a => a.project));

  return (
    <div className="border-b border-dark-800 bg-dark-900/30">
      <div className="max-w-[1800px] mx-auto px-4 sm:px-6 py-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
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
            icon={<MessageSquare className="w-4 h-4" />}
            label="Messages"
            value={stats.totalMessages}
            color="text-cyan-400"
            bgColor="bg-cyan-500/10"
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

function StatCard({ icon, label, value, color, bgColor, tooltip }) {
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
