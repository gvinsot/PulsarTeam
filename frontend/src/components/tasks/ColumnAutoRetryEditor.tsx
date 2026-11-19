import { useState } from 'react';
import { RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { useLanguage } from '../../contexts/LanguageContext';
import type { ColumnAutoRetry } from '../../types';
import {
  AUTO_RETRY_MAX,
  autoRetryMissingInstructions,
  isAutoRetryActive,
  parseMinutes,
} from './columnAutoRetry';

interface Props {
  value: ColumnAutoRetry | null | undefined;
  onChange: (next: ColumnAutoRetry) => void;
  /** Whether the column has a flow (on_enter / condition transition) to re-run. */
  hasFlow: boolean;
}

/**
 * Per-column auto-retry settings in the workflow editor: re-run the column's
 * flow every N minutes, and/or add an instruction after M minutes in the column.
 * Semantics: api/src/services/workflow/columnAutoRetry.ts.
 */
export default function ColumnAutoRetryEditor({ value, onChange, hasFlow }: Props) {
  const { t } = useLanguage();
  const config = value || {};
  const active = isAutoRetryActive(config);
  const [open, setOpen] = useState(active);
  const patch = (p: Partial<ColumnAutoRetry>) => onChange({ ...config, ...p });

  const summary = [
    config.intervalMinutes
      ? t('autoRetry.summary').replace('{n}', String(config.intervalMinutes))
      : null,
    config.escalateAfterMinutes
      ? t('autoRetry.summaryEscalation').replace('{n}', String(config.escalateAfterMinutes))
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const inputClass =
    'w-20 px-2 py-1 bg-dark-700 border border-dark-600 rounded text-xs text-dark-200';

  return (
    <div className="pt-1 border-t border-dark-700/60">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 text-[10px] text-dark-400 hover:text-dark-200"
        title={t('autoRetry.help')}
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <RefreshCw className={`w-3 h-3 ${active ? 'text-emerald-400' : ''}`} />
        <span className="font-semibold uppercase tracking-wider">{t('autoRetry.title')}</span>
        <span className={`ml-auto truncate ${active ? 'text-emerald-400' : ''}`}>
          {summary || t('autoRetry.off')}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-[10px] text-dark-500">{t('autoRetry.help')}</p>
          <label className="flex items-center justify-between gap-2 text-[10px] text-dark-400">
            <span>{t('autoRetry.every')}</span>
            <input
              type="number"
              min={0}
              max={AUTO_RETRY_MAX.intervalMinutes}
              value={config.intervalMinutes ?? ''}
              onChange={e =>
                patch({
                  intervalMinutes: parseMinutes(e.target.value, AUTO_RETRY_MAX.intervalMinutes),
                })
              }
              className={inputClass}
              placeholder="—"
            />
          </label>
          {!!config.intervalMinutes && (
            <label className="flex items-center justify-between gap-2 text-[10px] text-dark-400">
              <span>{t('autoRetry.maxRetries')}</span>
              <input
                type="number"
                min={0}
                max={AUTO_RETRY_MAX.maxRetries}
                value={config.maxRetries ?? ''}
                onChange={e =>
                  patch({ maxRetries: parseMinutes(e.target.value, AUTO_RETRY_MAX.maxRetries) })
                }
                className={inputClass}
                placeholder="0"
              />
            </label>
          )}
          <label className="flex items-center justify-between gap-2 text-[10px] text-dark-400">
            <span>{t('autoRetry.escalateAfter')}</span>
            <input
              type="number"
              min={0}
              max={AUTO_RETRY_MAX.escalateAfterMinutes}
              value={config.escalateAfterMinutes ?? ''}
              onChange={e =>
                patch({
                  escalateAfterMinutes: parseMinutes(
                    e.target.value,
                    AUTO_RETRY_MAX.escalateAfterMinutes
                  ),
                })
              }
              className={inputClass}
              placeholder="—"
            />
          </label>
          {!!config.escalateAfterMinutes && (
            <textarea
              value={config.escalationInstructions || ''}
              onChange={e => patch({ escalationInstructions: e.target.value })}
              maxLength={AUTO_RETRY_MAX.instructions}
              rows={3}
              placeholder={t('autoRetry.instructions')}
              className="w-full px-2 py-1 bg-dark-700 border border-dark-600 rounded text-xs text-dark-200 resize-y"
            />
          )}
          {autoRetryMissingInstructions(config) && (
            <p className="text-[10px] text-amber-400">{t('autoRetry.needsInstructions')}</p>
          )}
          {active && !hasFlow && (
            <p className="text-[10px] text-amber-400">{t('autoRetry.needsTransition')}</p>
          )}
        </div>
      )}
    </div>
  );
}
