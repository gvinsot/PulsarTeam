import { useEffect, useRef, useState } from 'react';
import { Download, FileText, Loader2, Upload, X } from 'lucide-react';
import {
  deleteTaskAttachment,
  getTaskAttachments,
  taskAttachmentUrl,
  uploadTaskAttachment,
} from '../../api';
import { errorMessage } from '../../utils/errors';
import type { TaskAttachment } from '../../types';

// Mirrors api/src/lib/taskAttachments.ts; the server enforces both.
const MAX_FILES = 20;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  /** Existing task: files are uploaded and deleted immediately. */
  taskId?: string;
  /** Task not created yet (no taskId): files are held until the caller uploads them. */
  pending?: File[];
  onPendingChange?: (files: File[]) => void;
}

/** Files attached to a task + a browse button / drop zone to add more. */
export default function TaskAttachmentsEditor({ taskId, pending = [], onPendingChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);
  const [uploading, setUploading] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    getTaskAttachments(taskId)
      .then(list => {
        if (!cancelled) setAttachments(list);
      })
      .catch(err => {
        if (!cancelled) setError(errorMessage(err) || 'Could not load attachments');
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const count = taskId ? attachments.length + uploading.length : pending.length;

  const handleFiles = async (list: FileList | null) => {
    if (!list) return;
    setError(null);
    const accepted: File[] = [];
    let slots = MAX_FILES - count;
    for (const file of Array.from(list)) {
      if (file.size > MAX_FILE_BYTES) {
        setError(`${file.name} is too large (max ${MAX_FILE_BYTES / (1024 * 1024)} MB)`);
      } else if (file.size === 0) {
        setError(`${file.name} is empty`);
      } else if (slots <= 0) {
        setError(`A task can hold at most ${MAX_FILES} files`);
      } else {
        accepted.push(file);
        slots--;
      }
    }
    if (!taskId) {
      onPendingChange?.([...pending, ...accepted]);
      return;
    }
    for (const file of accepted) {
      setUploading(prev => [...prev, file.name]);
      try {
        const added = await uploadTaskAttachment(taskId, file);
        setAttachments(prev => [...prev, added]);
      } catch (err) {
        setError(`${file.name}: ${errorMessage(err) || 'upload failed'}`);
      } finally {
        setUploading(prev => {
          const i = prev.indexOf(file.name);
          return i < 0 ? prev : [...prev.slice(0, i), ...prev.slice(i + 1)];
        });
      }
    }
  };

  const remove = async (attachment: TaskAttachment) => {
    if (!taskId) return;
    setError(null);
    try {
      await deleteTaskAttachment(taskId, attachment.id);
      setAttachments(prev => prev.filter(a => a.id !== attachment.id));
    } catch (err) {
      setError(errorMessage(err) || 'Could not remove the file');
    }
  };

  const chipClass =
    'inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-md bg-sky-500/10 text-sky-300 border border-sky-500/30 max-w-full';
  const removeButton = (onClick: () => void) => (
    <button type="button" title="Remove" onClick={onClick} className="hover:text-sky-100">
      <X className="w-3 h-3" />
    </button>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {taskId
          ? attachments.map(a => (
              <span key={a.id} className={chipClass}>
                <FileText className="w-3 h-3 shrink-0" />
                <a
                  href={taskAttachmentUrl(taskId, a.id)}
                  download={a.filename}
                  title={`Download ${a.filename}`}
                  className="truncate hover:underline"
                >
                  {a.filename}
                </a>
                <span className="text-sky-400/60">{formatFileSize(a.size)}</span>
                <Download className="w-3 h-3 text-sky-400/60 shrink-0" />
                {removeButton(() => void remove(a))}
              </span>
            ))
          : pending.map((f, i) => (
              <span key={`${f.name}-${i}`} className={chipClass}>
                <FileText className="w-3 h-3 shrink-0" />
                <span className="truncate">{f.name}</span>
                <span className="text-sky-400/60">{formatFileSize(f.size)}</span>
                {removeButton(() => onPendingChange?.(pending.filter((_, j) => j !== i)))}
              </span>
            ))}
        {uploading.map((name, i) => (
          <span key={`up-${name}-${i}`} className={`${chipClass} opacity-60`}>
            <Loader2 className="w-3 h-3 animate-spin" />
            {name}
          </span>
        ))}
        {count === 0 && <span className="text-xs text-dark-500 italic">None</span>}
      </div>
      <div
        onDragOver={e => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => {
          e.preventDefault();
          setDragOver(false);
          void handleFiles(e.dataTransfer.files);
        }}
        className={`mt-2 flex items-center justify-center gap-2 px-3 py-3 rounded-lg border border-dashed text-xs transition-colors ${
          dragOver ? 'border-sky-500 bg-sky-500/10 text-sky-300' : 'border-dark-700 text-dark-400'
        }`}
      >
        <Upload className="w-3.5 h-3.5" />
        <span>Drop files here or</span>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="text-sky-400 hover:text-sky-300 underline"
        >
          browse
        </button>
        <span className="text-dark-500">(max {MAX_FILE_BYTES / (1024 * 1024)} MB each)</span>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={e => {
            void handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {error && <div className="mt-1 text-[11px] text-red-400">{error}</div>}
    </div>
  );
}
