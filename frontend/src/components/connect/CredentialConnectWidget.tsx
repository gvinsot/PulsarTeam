import { useState, ReactNode } from 'react';
import { Loader2, CheckCircle, AlertCircle, Save } from 'lucide-react';
import { useConnectStatus, ConnectStatus } from './useConnectStatus';

/**
 * Generic credential-form connection widget shared by the providers that use
 * an inline credentials form instead of an OAuth popup (Jira, S3, WordPress).
 * Owns the status fetch, the showForm toggle, field state, validation and the
 * 'Save & Test Connection' flow.
 */

// Tailwind JIT requires the full class strings to appear literally in source,
// so each accent color maps to pre-built class strings per slot.
const COLOR_CLASSES = {
  blue: {
    card: 'bg-blue-500/5 border-blue-500/20',
    icon: 'text-blue-400',
    badge: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    button: 'bg-blue-500 hover:bg-blue-600',
    inputFocus: 'focus:border-blue-500',
  },
  orange: {
    card: 'bg-orange-500/5 border-orange-500/20',
    icon: 'text-orange-400',
    badge: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
    button: 'bg-orange-500 hover:bg-orange-600',
    inputFocus: 'focus:border-orange-500',
  },
  sky: {
    card: 'bg-sky-500/5 border-sky-500/20',
    icon: 'text-sky-400',
    badge: 'bg-sky-500/20 text-sky-400 border-sky-500/30',
    button: 'bg-sky-500 hover:bg-sky-600',
    inputFocus: 'focus:border-sky-500',
  },
};

export interface CredentialField {
  key: string;
  label: ReactNode;
  placeholder: string;
  /** Input type; defaults to 'text'. */
  type?: string;
  required?: boolean;
  /** Rendered below the input in the standard help paragraph. */
  help?: ReactNode;
  /** Initial value, restored after a successful connect; defaults to ''. */
  initial?: string;
}

export interface CredentialProviderConfig {
  name: string;
  /** Short name for the loading label + console prefix (e.g. 'S3' vs 'AWS S3'). */
  statusName?: string;
  Icon: any;
  /** Icon shown on the Disconnect button. */
  IconDisconnect: any;
  color: 'blue' | 'orange' | 'sky';
  /** Label of the form-toggle button (e.g. 'Connect Jira'). */
  connectButtonLabel: string;
  /** Full text of the connected badge (including any 'Connected' fallback). */
  badgeDetail: (status: ConnectStatus) => string;
  fields: CredentialField[];
  /** Validation message when required fields are missing. */
  requiredError: string;
  /** Optional node rendered at form level, between the fields and the submit button. */
  formFooter?: ReactNode;
  connect: (agentId: string, boardId: string | undefined, values: Record<string, string>) => Promise<any>;
  api: {
    getStatus: (agentId?: string, boardId?: string) => Promise<ConnectStatus>;
    disconnect: (agentId?: string, boardId?: string) => Promise<any>;
  };
  /** Hint shown below the card while disconnected and the form is closed. */
  connectHint: string;
}

const initialValues = (fields: CredentialField[]) =>
  Object.fromEntries(fields.map(f => [f.key, f.initial ?? '']));

export default function CredentialConnectWidget({ config, agentId, boardId, onStatusChange }: {
  config: CredentialProviderConfig;
  agentId?: string;
  boardId?: string;
  onStatusChange?: (status: ConnectStatus) => void;
}) {
  const { name, Icon, IconDisconnect } = config;
  const statusName = config.statusName || name;
  const colors = COLOR_CLASSES[config.color];
  const { status, loading, statusError, fetchStatus, retry } =
    useConnectStatus(statusName, config.api.getStatus, agentId, boardId, onStatusChange);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(config.fields));

  const requiredMissing = config.fields.some(f => f.required && !values[f.key]);

  const handleConnect = async () => {
    if (requiredMissing) {
      setError(config.requiredError);
      return;
    }
    setError(null);
    setConnecting(true);
    try {
      await config.connect(agentId || '', boardId || undefined, values);
      setShowForm(false);
      setValues(initialValues(config.fields));
      await fetchStatus();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await config.api.disconnect(agentId || undefined, boardId || undefined);
      await fetchStatus();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDisconnecting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-3 bg-dark-800/30 rounded-lg border border-dark-700/30">
        <Loader2 className="w-4 h-4 text-dark-400 animate-spin" />
        <span className="text-xs text-dark-400">Checking {statusName} status...</span>
      </div>
    );
  }

  if (statusError) {
    return (
      <div className="p-3 bg-dark-800/30 rounded-lg border border-dark-700/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className="w-4 h-4 text-dark-500" />
            <span className="text-sm font-medium text-dark-300">{name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/30">status check failed</span>
          </div>
          <button
            onClick={retry}
            className="px-2.5 py-1 text-xs text-dark-400 hover:text-dark-200 hover:bg-dark-700 rounded-lg transition-colors"
          >
            Retry
          </button>
        </div>
        <div className="mt-2 flex items-start gap-1.5 text-xs text-red-400">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>{statusError}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`p-3 rounded-lg border transition-colors ${
      status.connected
        ? colors.card
        : 'bg-dark-800/30 border-dark-700/30'
    }`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 ${status.connected ? colors.icon : 'text-dark-400'}`} />
          <span className="text-sm font-medium text-dark-200">{name}</span>
          {status.connected ? (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${colors.badge} flex items-center gap-1`}>
              <CheckCircle className="w-2.5 h-2.5" />
              {config.badgeDetail(status)}
            </span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-dark-700 text-dark-400 border border-dark-600">
              Disconnected
            </span>
          )}
        </div>

        {status.connected ? (
          <button
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="flex items-center gap-1 px-2.5 py-1 text-xs text-dark-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-40"
          >
            {disconnecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <IconDisconnect className="w-3 h-3" />}
            Disconnect
          </button>
        ) : (
          <button
            onClick={() => setShowForm(!showForm)}
            className={`flex items-center gap-1.5 px-3 py-1.5 ${colors.button} text-white rounded-lg text-xs font-medium transition-colors`}
          >
            <Icon className="w-3.5 h-3.5" />
            {showForm ? 'Cancel' : config.connectButtonLabel}
          </button>
        )}
      </div>

      {showForm && !status.connected && (
        <div className="mt-3 space-y-2">
          {config.fields.map(field => (
            <div key={field.key}>
              <label className="text-[11px] text-dark-400 block mb-1">{field.label}</label>
              <input
                type={field.type || 'text'}
                value={values[field.key]}
                onChange={(e) => setValues(v => ({ ...v, [field.key]: e.target.value }))}
                placeholder={field.placeholder}
                className={`w-full px-2.5 py-1.5 text-xs bg-dark-900 border border-dark-600 rounded-lg text-dark-200 placeholder-dark-500 ${colors.inputFocus} focus:outline-none`}
              />
              {field.help && (
                <p className="text-[10px] text-dark-500 mt-1">
                  {field.help}
                </p>
              )}
            </div>
          ))}
          {config.formFooter}
          <button
            onClick={handleConnect}
            disabled={connecting || requiredMissing}
            className={`flex items-center gap-1.5 px-3 py-1.5 ${colors.button} text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-40 w-full justify-center`}
          >
            {connecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {connecting ? 'Connecting...' : 'Save & Test Connection'}
          </button>
        </div>
      )}

      {error && (
        <div className="mt-2 flex items-start gap-1.5 text-xs text-red-400">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {!status.connected && !showForm && (
        <p className="mt-2 text-[11px] text-dark-500">
          {config.connectHint}
        </p>
      )}
    </div>
  );
}
