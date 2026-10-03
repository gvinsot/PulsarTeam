import { useEffect, useState } from 'react';
import { Bot, Loader2, MessageSquare, Send, Trash2, User, Cog } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { addTaskComment, deleteTaskComment } from '../../api';
import { errorMessage } from '../../utils/errors';
import type { TaskComment, TaskCommentAuthorType } from '../../types';
import { useUserDisplayName } from '../../hooks/useUserDisplayName';

// The comment thread of a task — kept SEPARATE from the description (task.text).
// Agents write here through update_task's `comment` / add_task_comment; people
// through the form below (POST /api/tasks/:id/comments).

interface TaskCommentsProps {
  taskId: string;
  /** Absent on some `task:updated` frames — treated as "unchanged / empty". */
  comments: TaskComment[] | null | undefined;
  /** Refresh the board after a mutation (the socket frame also arrives). */
  onChanged?: () => void;
}

const AUTHOR_STYLE: Record<TaskCommentAuthorType, { icon: typeof User; cls: string }> = {
  agent: { icon: Bot, cls: 'text-purple-300 bg-purple-500/10 ring-purple-500/30' },
  user: { icon: User, cls: 'text-sky-300 bg-sky-500/10 ring-sky-500/30' },
  system: { icon: Cog, cls: 'text-dark-300 bg-dark-700 ring-dark-600' },
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export default function TaskComments({ taskId, comments, onChanged }: TaskCommentsProps) {
  const [list, setList] = useState<TaskComment[]>(Array.isArray(comments) ? comments : []);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const displayName = useUserDisplayName();

  // Follow the task as socket frames / refreshes arrive.
  useEffect(() => {
    if (Array.isArray(comments)) setList(comments);
  }, [comments]);

  // Reset the draft when switching to another task.
  useEffect(() => {
    setDraft('');
    setError(null);
  }, [taskId]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || posting) return;
    setPosting(true);
    setError(null);
    try {
      const created = await addTaskComment(taskId, text);
      setList(prev => (prev.some(c => c.id === created.id) ? prev : [...prev, created]));
      setDraft('');
      onChanged?.();
    } catch (err) {
      setError(errorMessage(err) || 'Failed to add comment');
    } finally {
      setPosting(false);
    }
  };

  const remove = async (comment: TaskComment) => {
    if (!window.confirm('Delete this comment?')) return;
    setDeletingId(comment.id);
    setError(null);
    try {
      await deleteTaskComment(taskId, comment.id);
      setList(prev => prev.filter(c => c.id !== comment.id));
      onChanged?.();
    } catch (err) {
      setError(errorMessage(err) || 'Failed to delete comment');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <MessageSquare className="w-3.5 h-3.5 text-dark-400" />
        <span className="text-xs font-semibold text-dark-400 uppercase tracking-wide">
          Comments
        </span>
        {list.length > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-dark-700 text-dark-300">
            {list.length}
          </span>
        )}
      </div>

      {list.length === 0 ? (
        <p className="text-xs text-dark-500 italic mb-3">No comments yet.</p>
      ) : (
        <ul className="space-y-2.5 mb-3">
          {list.map(c => {
            const style = AUTHOR_STYLE[c.authorType] || AUTHOR_STYLE.system;
            const Icon = style.icon;
            return (
              <li
                key={c.id}
                className="group rounded-lg border border-dark-700 bg-dark-800/60 px-3 py-2"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={`flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded ring-1 ${style.cls}`}
                  >
                    <Icon className="w-3 h-3" />
                    {c.authorType === 'user' ? displayName(c.author) : c.author}
                  </span>
                  <span className="text-[10px] text-dark-500">{formatWhen(c.at)}</span>
                  <button
                    onClick={() => remove(c)}
                    disabled={deletingId === c.id}
                    className="ml-auto opacity-0 group-hover:opacity-100 p-1 rounded text-dark-500 hover:text-red-400 hover:bg-dark-700 transition-all disabled:opacity-50"
                    title="Delete comment"
                  >
                    {deletingId === c.id ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Trash2 className="w-3 h-3" />
                    )}
                  </button>
                </div>
                <div className="text-sm text-dark-200 leading-relaxed break-words [&_a]:text-blue-400 [&_a]:underline [&_code]:text-purple-300 [&_code]:text-xs [&_pre]:bg-dark-900 [&_pre]:p-2 [&_pre]:rounded [&_pre]:overflow-x-auto [&_ul]:list-disc [&_ul]:ml-4 [&_ol]:list-decimal [&_ol]:ml-4 [&_p]:my-1">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{c.text}</ReactMarkdown>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {error && <p className="text-xs text-red-400 mb-2">{error}</p>}

      <div className="flex items-end gap-2">
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
          maxLength={20000}
          placeholder="Add a comment (Markdown, Ctrl+Enter to send)…"
          className="flex-1 px-3 py-2 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 resize-y"
        />
        <button
          onClick={() => void submit()}
          disabled={posting || !draft.trim()}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 rounded-lg transition-colors"
          title="Add comment"
        >
          {posting ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Send className="w-3.5 h-3.5" />
          )}
          Comment
        </button>
      </div>
    </div>
  );
}
