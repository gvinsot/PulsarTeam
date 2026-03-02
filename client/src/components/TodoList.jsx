import React from 'react';

const STATUS_META = {
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

export default function TodoList({
  todos = [],
  onToggleTodo,
  onDeleteTodo,
  onExecuteTodo,
  onExecuteAllTodos
}) {
  const pendingCount = todos.filter(t => t.status === 'pending' || t.status === 'error').length;

  return (
    <div className="todo-list">
      <div className="todo-list-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h4 style={{ margin: 0 }}>Tasks</h4>
        <button
          onClick={onExecuteAllTodos}
          disabled={pendingCount === 0}
          title={pendingCount === 0 ? 'No pending tasks' : `Execute ${pendingCount} pending task(s)`}
        >
          Execute pending ({pendingCount})
        </button>
      </div>

      {todos.length === 0 ? (
        <p style={{ opacity: 0.7, marginTop: 8 }}>No tasks yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0 0', display: 'grid', gap: 8 }}>
          {todos.map(todo => {
            const isDone = todo.status === 'done';
            const isInProgress = todo.status === 'in_progress';
            return (
              <li
                key={todo.id}
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
                      <StatusBadge status={todo.status} />
                      <span style={{ textDecoration: isDone ? 'line-through' : 'none', opacity: isDone ? 0.75 : 1 }}>
                        {todo.text}
                      </span>
                    </div>
                    {todo.error ? (
                      <div style={{ marginTop: 6, color: '#ef4444', fontSize: 12 }}>
                        {todo.error}
                      </div>
                    ) : null}
                  </div>

                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => onToggleTodo(todo.id)} title="Toggle done/pending">
                      {isDone ? '↩' : '✓'}
                    </button>
                    <button onClick={() => onDeleteTodo(todo.id)} title="Delete task">
                      🗑
                    </button>
                    <button
                      onClick={() => onExecuteTodo(todo.id)}
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