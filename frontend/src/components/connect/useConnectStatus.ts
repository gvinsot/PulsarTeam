import { useState, useEffect, useCallback, useRef } from 'react';
import { errorMessage } from '../../utils/errors';

/**
 * The status object every connect widget renders. Mirrors `IntegrationStatus`
 * (api.ts) on the one key the two producer families disagree about:
 *
 *  - OAuth providers (onedrive, gmail, outlook, gdrive, slack, github) always
 *    emit `configured` — api/src/routes/oauthProviderRoutes.ts:137.
 *  - CREDENTIAL providers (jira, wordpress, s3) emit NO `configured` key at all —
 *    api/src/routes/lib/credentialConnector.ts:93-108.
 *
 * So `configured` is `boolean | undefined`, not `boolean`. Its only reader is
 * OAuthConnectWidget.tsx:189 (`if (!status.configured)`), which is on the OAuth
 * half and tests it by truthiness, so absent and `false` already render alike.
 */
export interface ConnectStatus {
  /** ABSENT on jira / wordpress / s3. */
  configured: boolean | undefined;
  connected: boolean;
  [key: string]: any;
}

/**
 * The props every connector widget accepts. A widget is scoped to an agent OR a
 * board and reports the status it fetched back to its parent. Declared here, next
 * to ConnectStatus, so MCP_CONNECTOR_MAP can be typed without importing a
 * component module back into the widgets.
 */
export interface ConnectWidgetProps {
  agentId?: string;
  boardId?: string;
  onStatusChange?: (status: ConnectStatus) => void;
}

/**
 * Shared status-fetch state for the integration connect widgets
 * (OAuth popups and credential forms alike).
 *
 * The onStatusChange callback is kept in a ref so parents can pass a new
 * inline function on every render without re-triggering the fetch effect.
 */
export function useConnectStatus(
  name: string,
  getStatus: (agentId?: string, boardId?: string) => Promise<ConnectStatus>,
  agentId?: string,
  boardId?: string,
  onStatusChange?: (status: ConnectStatus) => void
) {
  const [status, setStatus] = useState<ConnectStatus>({ configured: false, connected: false });
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  const fetchStatus = useCallback(async () => {
    setStatusError(null);
    try {
      const data = await getStatus(agentId || undefined, boardId || undefined);
      setStatus(data);
      onStatusChangeRef.current?.(data);
    } catch (err) {
      console.error(`${name} status check failed:`, err);
      setStatusError(errorMessage(err) || 'Status check failed');
    } finally {
      setLoading(false);
    }
  }, [name, getStatus, agentId, boardId]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // The Retry button flips the widget back into its loading state while re-fetching.
  const retry = () => {
    setLoading(true);
    fetchStatus();
  };

  return { status, loading, statusError, fetchStatus, retry };
}
