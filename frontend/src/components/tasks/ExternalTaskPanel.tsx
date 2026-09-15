import { useState } from 'react';
import { ShieldAlert, ShieldCheck, Loader2 } from 'lucide-react';
import { api } from '../../api';
import { errorMessage } from '../../utils/errors';
import type { TaskSecurityFlag, TaskSocketPayload } from '../../types';

interface ExternalTaskPanelProps {
  task: TaskSocketPayload;
  /** Called after a successful approval so the board reloads the task. */
  onApproved: () => void;
}

const SEVERITY_STYLE: Record<TaskSecurityFlag['severity'], string> = {
  high: 'text-red-300 bg-red-500/10 ring-red-500/30',
  medium: 'text-amber-300 bg-amber-500/10 ring-amber-500/30',
  low: 'text-dark-300 bg-dark-700/60 ring-dark-600',
};

/**
 * The approval gate of an external task (api/src/lib/taskTrust.ts).
 *
 * A task created through an insert key — a webhook, an integration, the public
 * contact form — was written by someone outside the organisation. No agent
 * reads it until a person does, here. The injection signals are shown for what
 * they are: reasons to read carefully, not a verdict. When any is high, the
 * approval takes a second, explicit click.
 */
export default function ExternalTaskPanel({ task, onApproved }: ExternalTaskPanelProps) {
  const [approving, setApproving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (task.trustLevel !== 'untrusted' && task.trustLevel !== 'approved') return null;

  const flags = task.securityFlags || [];
  const origin =
    task.source?.type === 'website' ? 'the public contact form' : 'an API integration (insert key)';

  if (task.trustLevel === 'approved') {
    const approval = [...(task.history || [])].reverse().find(h => h.type === 'trust_approved');
    return (
      <div className="flex items-start gap-2.5 p-3 rounded-lg bg-sky-500/10 border border-sky-500/20">
        <ShieldCheck className="w-4 h-4 text-sky-400 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-sky-200/80 leading-relaxed">
          External task from {origin}
          {approval?.by ? `, approved by ${approval.by}` : ', approved'}. Agents work on it in a
          restricted profile: fresh context, no credentials, no MCP servers.
        </p>
      </div>
    );
  }

  const hasHigh = flags.some(f => f.severity === 'high');

  const approve = async () => {
    if (hasHigh && !confirming) {
      setConfirming(true);
      return;
    }
    setApproving(true);
    setError(null);
    try {
      await api.approveTask(task.id);
      onApproved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setApproving(false);
    }
  };

  return (
    <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 space-y-2.5">
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="text-xs font-semibold text-amber-300">Awaiting approval</p>
          <p className="text-xs text-amber-100/80 leading-relaxed">
            Written outside the organisation, through {origin}. No agent will read or work on it
            until you approve it. Read the text above as a whole: an instruction aimed at an agent
            can look like an ordinary sentence.
          </p>
        </div>
      </div>

      {flags.length > 0 && (
        <ul className="space-y-1.5 pl-6">
          {flags.map(flag => (
            <li key={flag.code} className="text-xs">
              <span
                className={`inline-block px-1.5 py-0.5 mr-1.5 rounded ring-1 text-[10px] font-medium uppercase ${SEVERITY_STYLE[flag.severity]}`}
              >
                {flag.severity}
              </span>
              <span className="text-dark-200">{flag.label}</span>
              {flag.excerpt && (
                <code className="block mt-0.5 ml-1 text-[11px] text-dark-400 break-words">
                  “{flag.excerpt}”
                </code>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-xs text-red-400 pl-6">{error}</p>}

      <div className="flex items-center gap-2 pl-6">
        <button
          type="button"
          onClick={approve}
          disabled={approving}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${
            confirming
              ? 'bg-red-600 hover:bg-red-500 text-white'
              : 'bg-amber-600 hover:bg-amber-500 text-white'
          }`}
        >
          {approving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {confirming ? 'Approve despite the warnings' : 'Approve for agents'}
        </button>
        {confirming && (
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="px-2 py-1.5 text-xs text-dark-400 hover:text-dark-200"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
