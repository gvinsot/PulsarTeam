import React from 'react';

const SOURCE_META = {
  agent: { color: '#a855f7', label: name => `Agent: ${name}` },
  user:  { color: '#3b82f6', label: () => 'User' },
  api:   { color: '#6b7280', label: () => 'API' },
  mcp:   { color: '#f97316', label: () => 'MCP' },
};

function SourceBadge({ source }) {
  if (!source) return null;
  const meta = SOURCE_META[source.type] || { color: '#6b7280', label: () => source.type };
  const label = meta.label(source.name || '');
  return (
    <span
      title={`Assigned by: ${label}`}
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: '1px 6px',
        borderRadius: 4,
        background: `${meta.color}22`,
        color: meta.color,
        border: `1px solid ${meta.color}44`,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

const STATUS_META = {
  backlog: { label: 'Backlog', color: '#a855f7' },
  pending: { label: 'Pending', color: '#f59e0b' },
  in_progress: { label: 'In Progress', color: '#3b82f6' },
  error: { label: 'Error', color: '#ef4444' },
  done: { label: 'Completed', color: '#22c55e' }
};

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status || 'Unknown', color: '#6b7280' };
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: 999,
        background: `${meta.color}22`,
        color: meta.color,
        border: `1px solid ${meta.color}55`
      }}
      title={`Task status: ${meta.label}`}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: meta.color,
          display: 'inline-block'
        }}
      />
      {meta.label}
    </span>
  );
}

export default function TaskList({
  tasks = [],
  onToggleTask,
  onDeleteTask,
  onExecuteTask,
  onExecuteAllTasks
}) {
  const pendingCount = tasks.filter(t => t.status === 'pending' || t.status === 'error').length;

  return (
    <div className="task-list">
      <div className="task-list-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h4 style={{ margin: 0 }}>Tasks</h4>
        <button
          onClick={onExecuteAllTasks}
          disabled={pendingCount === 0}
          title={pendingCount === 0 ? 'No pending tasks' : `Execute ${pendingCount} pending task(s)`}
        >
          Execute pending ({pendingCount})
        </button>
      </div>

      {tasks.length === 0 ? (
        <p style={{ opacity: 0.7, marginTop: 8 }}>No tasks yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0 0', display: 'grid', gap: 8 }}>
          {tasks.map(task => {
            const isDone = task.status === 'done';
            const isInProgress = task.status === 'in_progress';
            return (
              <li
                key={task.id}
                style={{
                  border: '1px solid #2a2a2a',
                  borderRadius: 8,
                  padding: 10,
                  background: '#111'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <StatusBadge status={task.status} />
                      {task.project && (
                        <span style={{
                          fontSize: 11,
                          fontWeight: 600,
                          padding: '1px 6px',
                          borderRadius: 4,
                          background: '#6366f122',
                          color: '#818cf8',
                          border: '1px solid #6366f144'
                        }}>
                          {task.project}
                        </span>
                      )}
                      <SourceBadge source={task.source} />
                      <span style={{ textDecoration: isDone ? 'line-through' : 'none', opacity: isDone ? 0.75 : 1 }}>
                        {task.text}
                      </span>
                    </div>
                    {task.error ? (
                      <div style={{ marginTop: 6, color: '#ef4444', fontSize: 12 }}>
                        {task.error}
                      </div>
                    ) : null}
                  </div>

                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => onToggleTask(task.id)} title="Toggle done/pending">
                      {isDone ? '↩' : '✓'}
                    </button>
                    <button onClick={() => onDeleteTask(task.id)} title="Delete task">
                      🗑
                    </button>
                    <button
                      onClick={() => onExecuteTask(task.id)}
                      disabled={isInProgress}
                      title={isInProgress ? 'Task already in progress' : 'Execute this task'}
                    >
                      ▶
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}