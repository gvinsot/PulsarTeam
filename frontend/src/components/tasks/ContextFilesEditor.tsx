import { useRef, useState } from 'react';
import { FileText, Upload, X } from 'lucide-react';

const MAX_FILES = 20;
const MAX_FILE_BYTES = 200 * 1024;

interface ContextFilesEditorProps {
  files: string[];
  onChange: (next: string[]) => void;
  /** Called with the name and text content of each file picked/dropped from the user's PC. */
  onAttach?: (name: string, content: string) => void | Promise<void>;
}

export function contextFileBlock(name: string, content: string): string {
  return `\n\n### Context file: ${name}\n\`\`\`\n${content}\n\`\`\``;
}

/** Existing context-file chips + a browse button / drop zone to attach local files. */
export default function ContextFilesEditor({ files, onChange, onAttach }: ContextFilesEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [attached, setAttached] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = async (list: FileList | null) => {
    if (!list || !onAttach) return;
    setError(null);
    for (const file of Array.from(list)) {
      if (file.size > MAX_FILE_BYTES) {
        setError(`${file.name} is too large (max ${MAX_FILE_BYTES / 1024} KB)`);
        continue;
      }
      try {
        const content = await file.text();
        if (content.includes('\u0000')) {
          setError(`${file.name} is not a text file`);
          continue;
        }
        await onAttach(file.name, content);
        setAttached(prev => (prev.includes(file.name) ? prev : [...prev, file.name]));
      } catch {
        setError(`Could not read ${file.name}`);
      }
    }
  };

  const chip = (name: string, onRemove?: () => void) => (
    <span
      key={name}
      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-md bg-sky-500/10 text-sky-300 border border-sky-500/30"
    >
      <FileText className="w-3 h-3" />
      {name}
      {onRemove && (
        <button type="button" title="Remove" onClick={onRemove} className="hover:text-sky-100">
          <X className="w-3 h-3" />
        </button>
      )}
    </span>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {files.map(f => chip(f, () => onChange(files.filter(x => x !== f))))}
        {attached.map(a => chip(a))}
        {files.length === 0 && attached.length === 0 && (
          <span className="text-xs text-dark-500 italic">None</span>
        )}
      </div>
      {onAttach && (
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
      )}
      {error && <div className="mt-1 text-[11px] text-red-400">{error}</div>}
    </div>
  );
}
