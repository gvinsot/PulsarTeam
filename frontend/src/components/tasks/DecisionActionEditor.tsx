import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useLanguage } from '../../contexts/LanguageContext';
import { isDecisionModel } from '../../utils/llmConfig';
import type { LlmConfig } from '../../types';
import type { BoardWorkflowColumn, WorkflowActionDecision } from '../../types/board';

export default function DecisionActionEditor({
  action,
  columns,
  onChange,
}: {
  action: WorkflowActionDecision;
  columns: BoardWorkflowColumn[];
  onChange: (patch: Partial<WorkflowActionDecision>) => void;
}) {
  const { t } = useLanguage();
  const [models, setModels] = useState<LlmConfig[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    api
      .getLlmConfigs()
      .then(configs => {
        if (active) setModels(configs.filter(isDecisionModel));
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);
  const field =
    'w-full bg-dark-900 border border-dark-600 rounded px-2 py-1.5 text-xs text-dark-200';
  return (
    <div className="space-y-2 rounded border border-teal-500/30 p-3">
      <p className="text-xs text-dark-400">{t('decision.actionHelp')}</p>
      <label className="block text-xs text-dark-300">
        {t('decision.model')}
        <select
          className={field}
          value={action.llmConfigId}
          onChange={e => onChange({ llmConfigId: e.target.value })}
        >
          <option value="">{t('decision.selectModel')}</option>
          {models.map(model => (
            <option key={model.id} value={model.id}>
              {model.name} ({model.model})
            </option>
          ))}
          {action.llmConfigId && !models.some(model => model.id === action.llmConfigId) && (
            <option value={action.llmConfigId} disabled>
              {t('decision.unavailableModel')}
            </option>
          )}
        </select>
      </label>
      {failed && <p className="text-xs text-red-400">{t('decision.loadError')}</p>}
      {!failed && models.length === 0 && (
        <p className="text-xs text-dark-400">{t('decision.noModels')}</p>
      )}
      <label className="block text-xs text-dark-300">
        {t('decision.instructions')}
        <textarea
          className={`${field} h-20`}
          maxLength={2000}
          value={action.instructions}
          onChange={e => onChange({ instructions: e.target.value })}
          placeholder={t('decision.instructionsPlaceholder')}
        />
      </label>
      <div className="space-y-2">
        {(action.routes || []).map((route, index) => (
          <div key={index} className="flex flex-wrap gap-2">
            <select
              aria-label={t('decision.destination')}
              className={`${field} sm:w-40`}
              value={route.target}
              onChange={e =>
                onChange({
                  routes: action.routes.map((r, i) =>
                    i === index ? { ...r, target: e.target.value } : r
                  ),
                })
              }
            >
              <option value="">{t('decision.destination')}</option>
              {columns.map(column => (
                <option key={column.id} value={column.id}>
                  {column.label}
                </option>
              ))}
              {route.target && !columns.some(column => column.id === route.target) && (
                <option value={route.target} disabled>
                  {route.target} ({t('decision.missingColumn')})
                </option>
              )}
            </select>
            <input
              aria-label={t('decision.criteria')}
              className={`${field} flex-1 min-w-32`}
              maxLength={1000}
              placeholder={t('decision.criteria')}
              value={route.description}
              onChange={e =>
                onChange({
                  routes: action.routes.map((r, i) =>
                    i === index ? { ...r, description: e.target.value } : r
                  ),
                })
              }
            />
            <button
              type="button"
              className="text-xs text-red-400 disabled:opacity-40"
              disabled={action.routes.length <= 2}
              onClick={() => onChange({ routes: action.routes.filter((_, i) => i !== index) })}
            >
              {t('decision.remove')}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="text-xs text-teal-400 disabled:opacity-40"
          disabled={action.routes.length >= columns.length}
          onClick={() => onChange({ routes: [...action.routes, { target: '', description: '' }] })}
        >
          {t('decision.addRoute')}
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="text-xs text-dark-300">
          {t('decision.confidence')}
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            className={field}
            value={Number.isFinite(action.minConfidence) ? action.minConfidence : ''}
            onChange={e =>
              onChange({ minConfidence: e.target.value === '' ? NaN : Number(e.target.value) })
            }
          />
        </label>
        <label className="text-xs text-dark-300">
          {t('decision.fallback')}
          <select
            className={field}
            value={action.fallbackTarget || ''}
            onChange={e => onChange({ fallbackTarget: e.target.value })}
          >
            <option value="">{t('decision.manualReview')}</option>
            {columns.map(column => (
              <option key={column.id} value={column.id}>
                {column.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-xs text-dark-400">{t('decision.confidenceHelp')}</p>
    </div>
  );
}
