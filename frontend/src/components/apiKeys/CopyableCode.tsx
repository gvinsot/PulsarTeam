import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface CopyableCodeProps {
  code: string;
  /** Small caption above the block, e.g. "curl" or "JSON". */
  label?: string;
  className?: string;
}

/** A monospace block with a copy button. Scrolls horizontally, never wraps. */
export default function CopyableCode({ code, label, className = '' }: CopyableCodeProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard refused (insecure origin, permissions): the text stays selectable.
    }
  };

  return (
    <div className={`relative group ${className}`}>
      {label && (
        <div className="text-[10px] uppercase tracking-wide text-dark-500 mb-1">{label}</div>
      )}
      <pre className="bg-dark-950/60 border border-dark-700 rounded-lg p-3 pr-10 text-xs font-mono text-dark-200 overflow-x-auto whitespace-pre">
        {code}
      </pre>
      <button
        type="button"
        onClick={copy}
        title="Copy"
        aria-label="Copy to clipboard"
        className={`absolute right-2 ${label ? 'top-6' : 'top-2'} p-1.5 rounded-md bg-dark-800 border border-dark-700 transition-colors ${
          copied ? 'text-emerald-400' : 'text-dark-400 hover:text-dark-100'
        }`}
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}
