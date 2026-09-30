import { useState } from 'react';
import { FileText, X } from 'lucide-react';

const MAX_FILES = 20;

interface ContextFilesEditorProps {
  files: string[];
  onChange: (next: string[]) => void;
}

/** Chips + input to attach repo-relative file paths to a task's agent context. */
export default function ContextFilesEditor({ files, onChange }: ContextFilesEditorProps) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const path = draft.trim().replace(/^\.\//, '');
    setDraft('');
    if (!path || files.includes(path) || files.length >= MAX_FILES) return;
    onChange([...files, path]);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {files.map(f => (
          <span
            key={f}
            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-md bg-sky-500/10 text-sky-300 border border-sky-500/30"
          >
            <FileText className="w-3 h-3" />
            {f}
            <button
              type="button"
              title="Remove"
              onClick={() => onChange(files.filter(x => x !== f))}
              className="hover:text-sky-100"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        {files.length === 0 && <span className="text-xs text-dark-500 italic">None</span>}
      </div>
      <input
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        disabled={files.length >= MAX_FILES}
        placeholder="path/to/file.ts — press Enter to add"
        className="mt-2 w-full px-3 py-1.5 bg-dark-800 border border-dark-700 rounded-lg text-xs text-dark-200 focus:outline-none focus:border-sky-500 transition-colors"
      />
    </div>
  );
}
