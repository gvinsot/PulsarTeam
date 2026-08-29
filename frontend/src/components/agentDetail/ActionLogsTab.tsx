import { Play, Clock, Zap, AlertCircle, Activity, ListTodo } from 'lucide-react';

const MAX_LOGS_DISPLAYED = 30;

function formatDuration(ms) {
  if (ms == null) return null;
  if (ms < 1000) return '<1s';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const formatTokens = n => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

const typeConfig = {
  busy: {
    icon: Zap,
    color: 'text-amber-400',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/20',
    label: 'Busy',
  },
  idle: {
    icon: Clock,
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/20',
    label: 'Idle',
  },
  error: {
    icon: AlertCircle,
    color: 'text-red-400',
    bg: 'bg-red-500/10',
    border: 'border-red-500/20',
    label: 'Error',
  },
  warning: {
    icon: AlertCircle,
    color: 'text-orange-400',
    bg: 'bg-orange-500/10',
    border: 'border-orange-500/20',
    label: 'Warning',
  },
};

export default function ActionLogsTab({ agent }) {
  const logs = agent.actionLogs || [];

  // Compute stats over the full log set (logs are important for stats)
  const busyLogs = logs.filter(l => l.type === 'busy');
  const sessions = busyLogs.length;
  const totalWorkMs = busyLogs.reduce((sum, l) => sum + (l.durationMs || 0), 0);
  const totalTokens = (agent.metrics?.totalTokensIn || 0) + (agent.metrics?.totalTokensOut || 0);

  return (
    <div className="p-4 space-y-4">
      {/* Stats summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-dark-700/50 border border-dark-600/50 rounded-lg p-3 text-center">
          <div className="flex items-center justify-center gap-1.5 mb-1">
            <Play className="w-3.5 h-3.5 text-blue-400" />
            <span className="text-[11px] text-dark-400 uppercase tracking-wide font-medium">
              Sessions
            </span>
          </div>
          <p className="text-lg font-semibold text-dark-100">{sessions}</p>
        </div>
        <div className="bg-dark-700/50 border border-dark-600/50 rounded-lg p-3 text-center">
          <div className="flex items-center justify-center gap-1.5 mb-1">
            <Clock className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-[11px] text-dark-400 uppercase tracking-wide font-medium">
              Work Time
            </span>
          </div>
          <p className="text-lg font-semibold text-dark-100">
            {formatDuration(totalWorkMs) || '0s'}
          </p>
        </div>
        <div className="bg-dark-700/50 border border-dark-600/50 rounded-lg p-3 text-center">
          <div className="flex items-center justify-center gap-1.5 mb-1">
            <Zap className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-[11px] text-dark-400 uppercase tracking-wide font-medium">
              Tokens
            </span>
          </div>
          <p className="text-lg font-semibold text-dark-100">{formatTokens(totalTokens)}</p>
          {totalTokens > 0 && (
            <p className="text-[10px] text-dark-500 mt-0.5">
              {formatTokens(agent.metrics?.totalTokensIn || 0)} in /{' '}
              {formatTokens(agent.metrics?.totalTokensOut || 0)} out
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <h3 className="font-medium text-dark-200 text-sm">Action Logs</h3>
        <span className="text-xs text-dark-400">
          {logs.length > MAX_LOGS_DISPLAYED
            ? `showing ${MAX_LOGS_DISPLAYED} of ${logs.length} entries`
            : `${logs.length} entries`}
        </span>
      </div>

      {logs.length === 0 ? (
        <div className="text-center py-12 text-dark-500">
          <Activity className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No action logs yet</p>
          <p className="text-xs mt-1">
            Logs appear when the agent starts working, finishes, or encounters errors.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {[...logs]
            .reverse()
            .slice(0, MAX_LOGS_DISPLAYED)
            .map(log => {
              const config = typeConfig[log.type] || typeConfig.idle;
              const Icon = config.icon;
              return (
                <div
                  key={log.id}
                  className={`flex items-start gap-3 p-3 rounded-lg border ${config.bg} ${config.border}`}
                >
                  <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${config.color}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-semibold ${config.color}`}>
                          {config.label}
                        </span>
                        {log.durationMs != null && (
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded-full font-mono ${config.bg} ${config.color} opacity-80`}
                          >
                            {formatDuration(log.durationMs)}
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-dark-500">
                        {new Date(log.timestamp).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-sm text-dark-300 mt-0.5">
                      {log.type === 'busy' && log.message.includes(' — ') ? (
                        <>
                          {log.message.split(' — ')[0]} —{' '}
                          <span className="text-dark-200 font-medium">
                            {log.message.split(' — ').slice(1).join(' — ')}
                          </span>
                        </>
                      ) : (
                        log.message
                      )}
                    </p>
                    {log.taskTitle && (
                      <div className="flex items-center gap-1.5 mt-1">
                        <ListTodo className="w-3 h-3 text-purple-400 flex-shrink-0" />
                        <span className="text-xs text-purple-300/80 truncate">{log.taskTitle}</span>
                      </div>
                    )}
                    {log.error && (
                      <pre className="text-xs text-red-300/80 mt-1 whitespace-pre-wrap break-words bg-red-500/5 rounded p-2">
                        {log.error}
                      </pre>
                    )}
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
