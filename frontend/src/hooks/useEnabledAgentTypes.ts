import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import {
  AGENT_TYPE_IDS,
  normalizeAgentType,
  parseDisabledAgentTypes,
  type AgentTypeId,
} from '../utils/agentTypes';

/**
 * The agent types an admin has left switched on, for the runner pickers.
 *
 * GET /settings/general is open to every authenticated user (credential-shaped
 * values are masked for non-admins), so a plain fetch is enough — no admin
 * route needed. Until it resolves, and if it fails, every type is treated as
 * enabled: a settings hiccup must not empty the runner dropdown.
 */
export function useEnabledAgentTypes() {
  const [disabled, setDisabled] = useState<Set<AgentTypeId>>(() => new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then(s => {
        if (!cancelled) setDisabled(parseDisabledAgentTypes(s.disabledAgentTypes));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** '' (the "Auto" option) and unknown ids are never hidden. */
  const isAgentTypeEnabled = useCallback(
    (runner: string | null | undefined) => {
      const id = normalizeAgentType(runner);
      return !id || !disabled.has(id);
    },
    [disabled]
  );

  const enabledAgentTypes = AGENT_TYPE_IDS.filter(id => !disabled.has(id));

  return { enabledAgentTypes, isAgentTypeEnabled, disabledAgentTypes: disabled, loaded };
}
