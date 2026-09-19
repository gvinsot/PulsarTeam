import type { ConnectWidgetProps } from '../connect/useConnectStatus';
import AuthBrowserConnect, { type BrowserSitePreset } from './AuthBrowserConnect';

/**
 * LinkedIn connection — the authenticated-browser flow pinned to www.linkedin.com.
 * LinkedIn's OAuth API does not allow browsing, so the user shares their web
 * session through the PulsarTeam extension, in a slot separate from the generic
 * authenticated browser.
 */
const LINKEDIN: BrowserSitePreset = {
  site: 'linkedin',
  name: 'LinkedIn',
  url: 'https://www.linkedin.com/',
};

export default function LinkedInConnect(props: ConnectWidgetProps) {
  return <AuthBrowserConnect {...props} preset={LINKEDIN} />;
}
