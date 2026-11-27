import { useState } from 'react';
import type { AuthBrowserControl, AuthBrowserSession } from '../../api';
import { useLanguage } from '../../contexts/LanguageContext';
import type { TranslationKey } from '../../i18n/translations';
import { credentialsPayload, lifetimeChoices, type CredentialsForm } from './authBrowserSessions';

// Lifetime and automatic sign-in of ONE shared website session. Only the user
// who shared it (canControl) sees these controls; the API and the worker check
// that again. Credentials are write-only: nothing here ever reads them back.

type Run = (
  operation: AuthBrowserControl['operation'],
  session: AuthBrowserSession,
  extra?: Pick<AuthBrowserControl, 'lifetimeHours' | 'credentials'>
) => Promise<boolean>;

const EMPTY: CredentialsForm = { username: '', password: '', totpSecret: '', loginUrl: '' };

export default function AuthBrowserSessionSettings({
  session,
  busy,
  run,
}: {
  session: AuthBrowserSession;
  busy: boolean;
  run: Run;
}) {
  const { t } = useLanguage();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<CredentialsForm>(EMPTY);
  const [error, setError] = useState('');
  const lifetime = session.lifetimeHours || 8;
  const button =
    'px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs disabled:opacity-50';
  const input = 'block w-full bg-dark-900 border border-dark-600 rounded p-2 mt-1';

  async function save() {
    const payload = credentialsPayload(form, session.site || '');
    if ('error' in payload) {
      setError(payload.error);
      return;
    }
    setError('');
    const ok = await run('set_credentials', session, { credentials: payload.credentials });
    // Never keep the password in component state once it was sent.
    setForm(EMPTY);
    if (ok) setEditing(false);
  }

  const field = (key: keyof CredentialsForm, label: TranslationKey, type = 'text') => (
    <label className="block">
      {t(label)}
      <input
        className={input}
        type={type}
        autoComplete="off"
        value={form[key]}
        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
      />
    </label>
  );

  return (
    <div className="space-y-2 pt-1">
      <label className="block text-dark-300">
        {t('authBrowser.lifetime')}
        <select
          className={input}
          disabled={busy}
          value={lifetime}
          onChange={e =>
            void run('set_lifetime', session, { lifetimeHours: Number(e.target.value) })
          }
        >
          {lifetimeChoices(session).map(h => (
            <option key={h} value={h}>
              {t(`authBrowser.lifetime.${h}`)}
            </option>
          ))}
        </select>
      </label>
      <p className="text-dark-400">{t('authBrowser.lifetimeHelp')}</p>
      <p className="text-dark-300 font-medium">{t('authBrowser.autoLogin')}</p>
      {session.autoLogin && !editing && (
        <>
          <p className="text-dark-400">{t('authBrowser.autoLoginOn')}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => void run('relogin', session)}
            >
              {t('authBrowser.relogin')}
            </button>
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => setEditing(true)}
            >
              {t('authBrowser.autoLoginSetup')}
            </button>
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => void run('clear_credentials', session)}
            >
              {t('authBrowser.clearCredentials')}
            </button>
          </div>
        </>
      )}
      {!session.autoLogin && !editing && (
        <button type="button" className={button} disabled={busy} onClick={() => setEditing(true)}>
          {t('authBrowser.autoLoginSetup')}
        </button>
      )}
      {editing && (
        <form
          className="space-y-2"
          onSubmit={e => {
            e.preventDefault();
            void save();
          }}
        >
          <p className="text-amber-300">{t('authBrowser.autoLoginWarning')}</p>
          {field('username', 'authBrowser.username')}
          {field('password', 'authBrowser.password', 'password')}
          {field('totpSecret', 'authBrowser.totpSecret', 'password')}
          {field('loginUrl', 'authBrowser.loginUrl', 'url')}
          {error && (
            <p role="alert" className="text-red-400">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={button} disabled={busy}>
              {t('authBrowser.saveCredentials')}
            </button>
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => {
                setForm(EMPTY);
                setError('');
                setEditing(false);
              }}
            >
              {t('authBrowser.cancel')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
