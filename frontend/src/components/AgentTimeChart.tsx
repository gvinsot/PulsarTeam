import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Chart as ChartJS, CategoryScale, LinearScale, LineElement,
  PointElement, Title, Tooltip, Legend, Filler
} from 'chart.js';
import type { ChartOptions } from 'chart.js';
import { Line } from 'react-chartjs-2';
import { api } from '../api';
import { Clock, Users, TrendingUp, RefreshCw } from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';

ChartJS.register(CategoryScale, LinearScale, LineElement, PointElement, Title, Tooltip, Legend, Filler);

const AGENT_COLORS = [
  '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
  '#14b8a6', '#e879f9', '#22d3ee', '#a3e635', '#fb923c',
];

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0m';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) return remainMin > 0 ? `${hours}h ${remainMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return `${days}d ${remainHours}h`;
}

function getChartColors(theme) {
  if (theme === 'light') return { legend: '#475569', tick: '#64748b', grid: '#e2e8f0' };
  return { legend: '#94a3b8', tick: '#64748b', grid: '#1e293b' };
}

export default function AgentTimeChart({ projectName, days = 30 }) {
  // ThemeContext is untyped (createContext() without a type argument), so type the result locally.
  const { theme } = useTheme() as { theme: string };
  const cc = getChartColors(theme);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const cacheRef = useRef({});

  const loadData = useCallback(async () => {
    const cacheKey = `${projectName}:${days}`;
    if (cacheRef.current[cacheKey] && Date.now() - cacheRef.current[cacheKey].ts < 60000) {
      setData(cacheRef.current[cacheKey].data);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await api.getProjectAgentTime(projectName, days);
      setData(result);
      cacheRef.current[cacheKey] = { data: result, ts: Date.now() };
    } catch (err) {
      console.error('Failed to load agent time data:', err);
    } finally {
      setLoading(false);
    }
  }, [projectName, days]);

  useEffect(() => { loadData(); }, [loadData]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-purple-500" />
      </div>
    );
  }

  if (!data || !data.agents?.length) {
    return (
      <div className="flex items-center justify-center py-8 text-dark-500 text-xs">
        No agent activity data in this period
      </div>
    );
  }

  const { agents, daily, totalMs, avgDailyMs } = data;

  const chartData = {
    labels: daily.map(d => d.date?.slice(5) || ''),
    datasets: agents.map((agent, idx) => ({
      label: agent.name,
      data: daily.map(d => Math.round((d.agentTimes[agent.id] || 0) / 60000)),
      borderColor: AGENT_COLORS[idx % AGENT_COLORS.length],
      backgroundColor: AGENT_COLORS[idx % AGENT_COLORS.length] + '20',
      fill: false,
      tension: 0.3,
      pointRadius: 2,
      pointHoverRadius: 5,
      borderWidth: 2,
    })),
  };

  const chartOpts: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          color: cc.legend,
          font: { size: 11 },
          usePointStyle: true,
          pointStyle: 'circle',
          padding: 16,
        },
      },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const mins = ctx.parsed.y;
            return `${ctx.dataset.label}: ${formatDuration(mins * 60000)}`;
          },
          footer: (items) => {
            const total = items.reduce((sum, i) => sum + i.parsed.y, 0);
            return `Total: ${formatDuration(total * 60000)}`;
          },
        },
      },
    },
    scales: {
      x: {
        ticks: { color: cc.tick, font: { size: 10 }, maxRotation: 45 },
        grid: { color: cc.grid },
      },
      y: {
        ticks: {
          color: cc.tick,
          font: { size: 10 },
          callback: (val) => formatDuration(Number(val) * 60000),
        },
        grid: { color: cc.grid },
        beginAtZero: true,
        title: {
          display: true,
          text: 'Time',
          color: cc.tick,
          font: { size: 10 },
        },
      },
    },
  };

  return (
    <div className="space-y-3">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <MiniStat
          icon={<Clock size={12} className="text-purple-400" />}
          label="Total Time"
          value={formatDuration(totalMs)}
        />
        <MiniStat
          icon={<TrendingUp size={12} className="text-blue-400" />}
          label="Daily Avg"
          value={formatDuration(avgDailyMs)}
        />
        <MiniStat
          icon={<Users size={12} className="text-emerald-400" />}
          label="Active Agents"
          value={agents.length}
        />
      </div>

      {/* Chart */}
      <div className="bg-dark-900/50 border border-dark-700 rounded-lg p-3">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-medium text-dark-300 flex items-center gap-1.5">
            <Users size={12} className="text-purple-400" />
            Time Spent by Agent
          </h4>
          <button
            onClick={loadData}
            className="text-dark-400 hover:text-dark-100 p-1"
            title="Refresh"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="h-64 sm:h-72 overflow-x-auto">
          <div className="min-w-[500px] h-full">
            <Line data={chartData} options={chartOpts} />
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniStat({ icon, label, value }) {
  return (
    <div className="bg-dark-700/50 rounded-lg px-3 py-2">
      <div className="text-xs text-dark-400 flex items-center gap-1 mb-0.5">
        {icon} {label}
      </div>
      <div className="text-sm text-dark-100 font-medium">{value}</div>
    </div>
  );
}
