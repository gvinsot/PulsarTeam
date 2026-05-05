import { useState, useEffect, useRef } from 'react';
import { Lock, User, AlertCircle, ChevronRight, Bot, LayoutDashboard, FolderKanban, DollarSign, Zap, Shield, Globe, ArrowRight, Play, X, ChevronDown, Mail, Phone, Building2, MessageSquare, Github, Headphones, Send } from 'lucide-react';
import { api } from '../api';
import { useLanguage } from '../contexts/LanguageContext';
import TermsPage from './TermsPage';
import PrivacyPage from './PrivacyPage';

/* ── Reusable tiny components ── */

function Logo({ size = 'lg' }: { size?: 'sm' | 'lg' }) {
  const dim = size === 'lg' ? 'w-12 h-12' : 'w-9 h-9';
  const icon = size === 'lg' ? 'w-6 h-6' : 'w-5 h-5';
  return (
    <div className={`inline-flex items-center justify-center ${dim} rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-lg shadow-indigo-500/20`}>
      <svg className={`${icon} text-white`} viewBox="0 0 100 100" fill="none">
        <circle cx="50" cy="25" r="10" fill="currentColor"/>
        <circle cx="25" cy="65" r="10" fill="currentColor" opacity="0.7"/>
        <circle cx="75" cy="65" r="10" fill="currentColor" opacity="0.7"/>
        <line x1="50" y1="35" x2="25" y2="55" stroke="currentColor" strokeWidth="3" opacity="0.5"/>
        <line x1="50" y1="35" x2="75" y2="55" stroke="currentColor" strokeWidth="3" opacity="0.5"/>
        <line x1="25" y1="75" x2="75" y2="75" stroke="currentColor" strokeWidth="3" opacity="0.3"/>
      </svg>
    </div>
  );
}

function FeatureCard({ icon: Icon, title, desc }: { icon: any; title: string; desc: string }) {
  return (
    <div className="group p-6 rounded-2xl bg-dark-800/50 border border-dark-700/50 hover:border-indigo-500/30 hover:bg-dark-800/80 transition-all duration-300">
      <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center mb-4 group-hover:bg-indigo-500/20 transition-colors">
        <Icon className="w-5 h-5 text-indigo-400" />
      </div>
      <h3 className="text-lg font-semibold text-dark-100 mb-2">{title}</h3>
      <p className="text-dark-400 text-sm leading-relaxed">{desc}</p>
    </div>
  );
}

/* ── Screenshot carousel ── */

function ScreenshotCarousel() {
  const { t } = useLanguage();
  const screenshots = [
    { src: '/screenshots/screenshot-agents.png', labelKey: 'screenshots.agents.label' as const, captionKey: 'screenshots.agents.caption' as const },
    { src: '/screenshots/screenshot-tasks.png', labelKey: 'screenshots.tasks.label' as const, captionKey: 'screenshots.tasks.caption' as const },
    { src: '/screenshots/screenshot-projects.png', labelKey: 'screenshots.projects.label' as const, captionKey: 'screenshots.projects.caption' as const },
    { src: '/screenshots/screenshot-budget.png', labelKey: 'screenshots.budget.label' as const, captionKey: 'screenshots.budget.caption' as const },
  ];

  const [active, setActive] = useState(0);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    intervalRef.current = setInterval(() => setActive(p => (p + 1) % screenshots.length), 5000);
    return () => clearInterval(intervalRef.current);
  }, []);

  const goTo = (i: number) => {
    setActive(i);
    clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => setActive(p => (p + 1) % screenshots.length), 5000);
  };

  return (
    <>
      <div className="relative">
        {/* Browser chrome frame */}
        <div className="rounded-xl overflow-hidden border border-dark-700/60 shadow-2xl shadow-black/40">
          <div className="flex items-center gap-2 px-4 py-2.5 bg-dark-800/90 border-b border-dark-700/60">
            <div className="flex gap-1.5">
              <div className="w-3 h-3 rounded-full bg-red-500/70" />
              <div className="w-3 h-3 rounded-full bg-amber-500/70" />
              <div className="w-3 h-3 rounded-full bg-emerald-500/70" />
            </div>
            <div className="flex-1 flex justify-center">
              <div className="px-4 py-1 rounded-md bg-dark-700/60 text-dark-400 text-xs font-mono">
                app.pulsarteam.io
              </div>
            </div>
          </div>
          <div className="relative aspect-[16/9] bg-dark-900 overflow-hidden cursor-pointer" onClick={() => setLightbox(active)}>
            {screenshots.map((s, i) => (
              <img
                key={s.src}
                src={s.src}
                alt={t(s.labelKey)}
                className={`absolute inset-0 w-full h-full object-cover object-top transition-opacity duration-700 ${i === active ? 'opacity-100' : 'opacity-0'}`}
                loading={i === 0 ? 'eager' : 'lazy'}
              />
            ))}
          </div>
        </div>

        {/* Caption */}
        <div className="mt-4 text-center">
          <p className="text-dark-100 font-medium">{t(screenshots[active].labelKey)}</p>
          <p className="text-dark-400 text-sm mt-1">{t(screenshots[active].captionKey)}</p>
        </div>

        {/* Dots */}
        <div className="flex justify-center gap-2 mt-4">
          {screenshots.map((s, i) => (
            <button
              key={i}
              onClick={() => goTo(i)}
              className={`h-1.5 rounded-full transition-all duration-300 ${i === active ? 'w-8 bg-indigo-500' : 'w-1.5 bg-dark-600 hover:bg-dark-500'}`}
              aria-label={t(s.labelKey)}
            />
          ))}
        </div>
      </div>

      {/* Lightbox */}
      {lightbox !== null && (
        <div className="fixed inset-0 z-[200] bg-black/90 flex items-center justify-center p-4 animate-fadeIn" onClick={() => setLightbox(null)}>
          <button className="absolute top-4 right-4 text-dark-400 hover:text-white" onClick={() => setLightbox(null)}>
            <X className="w-6 h-6" />
          </button>
          <img src={screenshots[lightbox].src} alt={t(screenshots[lightbox].labelKey)} className="max-w-full max-h-[90vh] rounded-lg shadow-2xl" onClick={e => e.stopPropagation()} />
        </div>
      )}
    </>
  );
}

/* ── Login form (slide-out panel) ── */

function LoginPanel({ open, onClose, onLogin, onGoogleLogin, googleLoading }: {
  open: boolean;
  onClose: () => void;
  onLogin: (u: string, p: string) => Promise<void>;
  onGoogleLogin?: (() => void) | null;
  googleLoading?: boolean;
}) {
  const { t } = useLanguage();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await onLogin(username, password);
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${open ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={onClose}
      />

      {/* Panel */}
      <div className={`fixed top-0 right-0 z-[101] h-full w-full max-w-md bg-dark-900 border-l border-dark-700/60 shadow-2xl transition-transform duration-300 ${open ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="flex flex-col h-full p-8">
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-3">
              <Logo size="sm" />
              <span className="text-xl font-bold text-dark-100">{t('login.title')}</span>
            </div>
            <button onClick={onClose} className="p-2 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-dark-800 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="flex-1 flex flex-col gap-5">
            {error && (
              <div className="flex items-center gap-2 text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-sm animate-fadeIn">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-dark-300 mb-2">{t('login.username')}</label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-dark-400" />
                <input
                  type="text"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-dark-800 border border-dark-600 rounded-xl text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                  placeholder={t('login.usernamePlaceholder')}
                  autoFocus={open}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-dark-300 mb-2">{t('login.password')}</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-dark-400" />
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-dark-800 border border-dark-600 rounded-xl text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                  placeholder={t('login.passwordPlaceholder')}
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || !username || !password}
              className="w-full py-3 px-4 bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-semibold rounded-xl hover:from-indigo-600 hover:to-purple-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-dark-900 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-lg shadow-indigo-500/25"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  {t('login.connecting')}
                </span>
              ) : t('login.submit')}
            </button>

            {onGoogleLogin && (
              <>
                <div className="relative">
                  <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-dark-600" /></div>
                  <div className="relative flex justify-center text-sm"><span className="px-3 bg-dark-900 text-dark-400">{t('login.or')}</span></div>
                </div>
                <button
                  type="button"
                  onClick={onGoogleLogin}
                  disabled={googleLoading}
                  className="w-full py-3 px-4 bg-dark-800 border border-dark-600 text-dark-100 font-medium rounded-xl hover:bg-dark-700 hover:border-dark-500 focus:outline-none focus:ring-2 focus:ring-dark-400 focus:ring-offset-2 focus:ring-offset-dark-900 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 flex items-center justify-center gap-3"
                >
                  {googleLoading ? (
                    <span className="flex items-center justify-center gap-2">
                      <div className="w-4 h-4 border-2 border-dark-300 border-t-transparent rounded-full animate-spin" />
                      {t('login.googleRedirecting')}
                    </span>
                  ) : (
                    <>
                      <svg className="w-5 h-5" viewBox="0 0 24 24">
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                      </svg>
                      {t('login.google')}
                    </>
                  )}
                </button>
              </>
            )}

            <p className="text-center text-dark-500 text-xs mt-auto">
              {t('login.secure')}
            </p>
          </form>
        </div>
      </div>
    </>
  );
}

/* ── Contact / Support form modal ── */

function ContactFormModal({ open, onClose, type }: {
  open: boolean;
  onClose: () => void;
  type: 'contact' | 'support';
}) {
  const { t } = useLanguage();
  const [form, setForm] = useState({ name: '', email: '', phone: '', company: '', message: '' });
  const [sending, setSending] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const handleChange = (field: string, value: string) => setForm(f => ({ ...f, [field]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSending(true);
    try {
      await api.submitContact({ ...form, type });
      setSuccess(true);
    } catch (err: any) {
      setError(err.message || 'Failed to submit. Please try again.');
    } finally {
      setSending(false);
    }
  };

  const handleClose = () => {
    setForm({ name: '', email: '', phone: '', company: '', message: '' });
    setSuccess(false);
    setError('');
    onClose();
  };

  const title = type === 'contact' ? t('contact.title') : t('contact.titleSupport');
  const subtitle = type === 'contact' ? t('contact.subtitle') : t('contact.subtitleSupport');

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm animate-fadeIn" onClick={handleClose} />
      <div className="fixed inset-0 z-[101] flex items-center justify-center p-4" onClick={handleClose}>
        <div className="bg-dark-900 border border-dark-700/60 rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
          <div className="p-6 sm:p-8">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-xl font-bold text-dark-100">{title}</h2>
                <p className="text-dark-400 text-sm mt-1">{subtitle}</p>
              </div>
              <button onClick={handleClose} className="p-2 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-dark-800 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            {success ? (
              <div className="text-center py-8">
                <div className="w-16 h-16 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto mb-4">
                  <Send className="w-7 h-7 text-emerald-400" />
                </div>
                <h3 className="text-lg font-semibold text-dark-100 mb-2">{t('contact.successTitle')}</h3>
                <p className="text-dark-400 text-sm">{t('contact.successMessage')}</p>
                <button onClick={handleClose} className="mt-6 px-6 py-2.5 text-sm font-medium rounded-xl bg-dark-800 border border-dark-600 text-dark-300 hover:bg-dark-700 transition-colors">
                  {t('contact.close')}
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <div className="flex items-center gap-2 text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-sm">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    {error}
                  </div>
                )}

                {/* Name */}
                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-1.5">{t('contact.name')}</label>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-dark-400" />
                    <input
                      type="text"
                      value={form.name}
                      onChange={e => handleChange('name', e.target.value)}
                      className="w-full pl-10 pr-4 py-2.5 bg-dark-800 border border-dark-600 rounded-xl text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors text-sm"
                      placeholder={t('contact.namePlaceholder')}
                    />
                  </div>
                </div>

                {/* Email (required) */}
                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-1.5">
                    {t('contact.email')} <span className="text-red-400">*</span>
                  </label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-dark-400" />
                    <input
                      type="email"
                      required
                      value={form.email}
                      onChange={e => handleChange('email', e.target.value)}
                      className="w-full pl-10 pr-4 py-2.5 bg-dark-800 border border-dark-600 rounded-xl text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors text-sm"
                      placeholder={t('contact.emailPlaceholder')}
                    />
                  </div>
                </div>

                {/* Phone (required) */}
                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-1.5">
                    {t('contact.phone')} <span className="text-red-400">*</span>
                  </label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-dark-400" />
                    <input
                      type="tel"
                      required
                      value={form.phone}
                      onChange={e => handleChange('phone', e.target.value)}
                      className="w-full pl-10 pr-4 py-2.5 bg-dark-800 border border-dark-600 rounded-xl text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors text-sm"
                      placeholder={t('contact.phonePlaceholder')}
                    />
                  </div>
                </div>

                {/* Company */}
                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-1.5">{t('contact.company')}</label>
                  <div className="relative">
                    <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-dark-400" />
                    <input
                      type="text"
                      value={form.company}
                      onChange={e => handleChange('company', e.target.value)}
                      className="w-full pl-10 pr-4 py-2.5 bg-dark-800 border border-dark-600 rounded-xl text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors text-sm"
                      placeholder={t('contact.companyPlaceholder')}
                    />
                  </div>
                </div>

                {/* Message */}
                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-1.5">{t('contact.message')}</label>
                  <div className="relative">
                    <MessageSquare className="absolute left-3 top-3 w-4 h-4 text-dark-400" />
                    <textarea
                      value={form.message}
                      onChange={e => handleChange('message', e.target.value)}
                      rows={4}
                      className="w-full pl-10 pr-4 py-2.5 bg-dark-800 border border-dark-600 rounded-xl text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors text-sm resize-none"
                      placeholder={type === 'contact' ? t('contact.messagePlaceholder') : t('contact.messagePlaceholderSupport')}
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={sending || !form.email || !form.phone}
                  className="w-full py-3 px-4 bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-semibold rounded-xl hover:from-indigo-600 hover:to-purple-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-dark-900 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-lg shadow-indigo-500/25 text-sm"
                >
                  {sending ? (
                    <span className="flex items-center justify-center gap-2">
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      {t('contact.sending')}
                    </span>
                  ) : t('contact.submit')}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/* ── CTA options card ── */

function CtaOptionCard({ icon: Icon, title, desc, onClick, href, accent = false, ctaLabel }: {
  icon: any;
  title: string;
  desc: string;
  onClick?: () => void;
  href?: string;
  accent?: boolean;
  ctaLabel: string;
}) {
  const cls = accent
    ? 'bg-gradient-to-br from-indigo-500/10 to-purple-500/10 border-indigo-500/30 hover:border-indigo-400/50 hover:from-indigo-500/15 hover:to-purple-500/15'
    : 'bg-dark-800/50 border-dark-700/50 hover:border-dark-600 hover:bg-dark-800/80';

  const content = (
    <div className={`group p-6 rounded-2xl border ${cls} transition-all duration-300 cursor-pointer h-full flex flex-col`}>
      <div className={`w-11 h-11 rounded-xl ${accent ? 'bg-indigo-500/20' : 'bg-dark-700/60'} flex items-center justify-center mb-4 group-hover:scale-105 transition-transform`}>
        <Icon className={`w-5 h-5 ${accent ? 'text-indigo-400' : 'text-dark-300'}`} />
      </div>
      <h3 className="text-base font-semibold text-dark-100 mb-2">{title}</h3>
      <p className="text-dark-400 text-sm leading-relaxed flex-1">{desc}</p>
      <div className={`mt-4 flex items-center gap-1.5 text-sm font-medium ${accent ? 'text-indigo-400' : 'text-dark-300'} group-hover:gap-2.5 transition-all`}>
        {ctaLabel}
        <ArrowRight className="w-4 h-4" />
      </div>
    </div>
  );

  if (href) {
    return <a href={href} target="_blank" rel="noopener noreferrer" className="block">{content}</a>;
  }
  return <div onClick={onClick}>{content}</div>;
}

/* ── Language toggle ── */

function LanguageToggle() {
  const { lang, toggleLang } = useLanguage();
  return (
    <button
      onClick={toggleLang}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-medium text-dark-400 hover:text-dark-200 hover:bg-dark-800/60 transition-colors"
      title={lang === 'en' ? 'Passer en français' : 'Switch to English'}
    >
      <Globe className="w-4 h-4" />
      <span className="uppercase">{lang}</span>
    </button>
  );
}

/* ── Main landing page ── */

export default function LoginPage({ onLogin, onGoogleLogin, googleLoading }: {
  onLogin: (u: string, p: string) => Promise<void>;
  onGoogleLogin?: any;
  googleLoading?: boolean;
}) {
  const { t } = useLanguage();
  const [loginOpen, setLoginOpen] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [contactModal, setContactModal] = useState<{ open: boolean; type: 'contact' | 'support' }>({ open: false, type: 'contact' });
  const [legalPage, setLegalPage] = useState<'terms' | 'privacy' | null>(null);

  useEffect(() => {
    api.googleStatus().then(data => setGoogleEnabled(!!data.enabled)).catch(() => {});
  }, []);

  const handleGoogleLogin = async () => {
    setGoogleBusy(true);
    try {
      const redirectUri = `${window.location.origin}/auth/google/callback`;
      const data = await api.googleAuthUrl(redirectUri);
      window.location.href = data.url;
    } catch {
      setGoogleBusy(false);
    }
  };

  if (legalPage === 'terms') return <TermsPage onBack={() => setLegalPage(null)} />;
  if (legalPage === 'privacy') return <PrivacyPage onBack={() => setLegalPage(null)} />;

  return (
    <div className="min-h-screen bg-dark-950 text-dark-200">
      {/* ─── Navbar ─── */}
      <nav className="fixed top-0 inset-x-0 z-50 border-b border-dark-800/80 bg-dark-950/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Logo size="sm" />
            <span className="text-xl font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
              PulsarTeam
            </span>
          </div>
          <div className="flex items-center gap-3">
            <a href="#features" className="hidden sm:inline-flex text-sm text-dark-400 hover:text-dark-200 transition-colors px-3 py-2">
              {t('nav.features')}
            </a>
            <a href="#screenshots" className="hidden sm:inline-flex text-sm text-dark-400 hover:text-dark-200 transition-colors px-3 py-2">
              {t('nav.product')}
            </a>
            <LanguageToggle />
            <button
              onClick={() => setLoginOpen(true)}
              className="px-5 py-2 text-sm font-medium rounded-lg bg-gradient-to-r from-indigo-500 to-purple-600 text-white hover:from-indigo-600 hover:to-purple-700 transition-all shadow-lg shadow-indigo-500/20"
            >
              {t('nav.signIn')}
            </button>
          </div>
        </div>
      </nav>

      {/* ─── Hero ─── */}
      <section className="relative pt-32 pb-20 lg:pt-44 lg:pb-32 overflow-hidden">
        {/* Background effects */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] bg-indigo-500/[0.07] rounded-full blur-[120px]" />
          <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] bg-purple-500/[0.06] rounded-full blur-[100px]" />
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-indigo-500/[0.03] rounded-full blur-[80px]" />
          {/* Grid pattern */}
          <div className="absolute inset-0" style={{
            backgroundImage: 'radial-gradient(circle at 1px 1px, rgb(99 102 241 / 0.05) 1px, transparent 0)',
            backgroundSize: '48px 48px'
          }} />
        </div>

        <div className="relative max-w-7xl mx-auto px-6">
          <div className="max-w-3xl mx-auto text-center">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-sm font-medium mb-8">
              <Zap className="w-3.5 h-3.5" />
              {t('hero.badge')}
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-dark-50 leading-tight tracking-tight">
              {t('hero.title.part1')}{' '}
              <span className="bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
                {t('hero.title.highlight')}
              </span>
            </h1>

            <p className="mt-6 text-lg sm:text-xl text-dark-400 leading-relaxed max-w-2xl mx-auto">
              {t('hero.subtitle')}
            </p>

            {/* Get Started — 3 options */}
            <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-4 max-w-4xl mx-auto text-left">
              <CtaOptionCard
                icon={Mail}
                title={t('cta.contact.title')}
                desc={t('cta.contact.desc')}
                onClick={() => setContactModal({ open: true, type: 'contact' })}
                ctaLabel={t('cta.getStarted')}
                accent
              />
              <CtaOptionCard
                icon={Github}
                title={t('cta.selfDeploy.title')}
                desc={t('cta.selfDeploy.desc')}
                href="https://github.com/gvinsot/PulsarTeam"
                ctaLabel={t('cta.viewOnGithub')}
              />
              <CtaOptionCard
                icon={Headphones}
                title={t('cta.support.title')}
                desc={t('cta.support.desc')}
                onClick={() => setContactModal({ open: true, type: 'support' })}
                ctaLabel={t('cta.getStarted')}
              />
            </div>

            {/* Tech stack badges */}
            <div className="mt-14 flex flex-wrap items-center justify-center gap-3">
              {['Claude', 'GPT', 'Mistral', 'Ollama', 'vLLM'].map(name => (
                <span key={name} className="px-3 py-1 rounded-md bg-dark-800/60 border border-dark-700/50 text-dark-400 text-xs font-medium">
                  {name}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ─── Features grid ─── */}
      <section id="features" className="py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-dark-50">
              {t('features.title')}
            </h2>
            <p className="mt-4 text-dark-400 text-lg max-w-2xl mx-auto">
              {t('features.subtitle')}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            <FeatureCard icon={Bot} title={t('features.agentMgmt.title')} desc={t('features.agentMgmt.desc')} />
            <FeatureCard icon={FolderKanban} title={t('features.kanban.title')} desc={t('features.kanban.desc')} />
            <FeatureCard icon={LayoutDashboard} title={t('features.projects.title')} desc={t('features.projects.desc')} />
            <FeatureCard icon={DollarSign} title={t('features.budget.title')} desc={t('features.budget.desc')} />
            <FeatureCard icon={Zap} title={t('features.swarm.title')} desc={t('features.swarm.desc')} />
            <FeatureCard icon={Globe} title={t('features.multiProvider.title')} desc={t('features.multiProvider.desc')} />
            <FeatureCard icon={Shield} title={t('features.sandbox.title')} desc={t('features.sandbox.desc')} />
            <FeatureCard icon={Play} title={t('features.plugins.title')} desc={t('features.plugins.desc')} />
            <FeatureCard icon={ChevronRight} title={t('features.openSource.title')} desc={t('features.openSource.desc')} />
          </div>
        </div>
      </section>

      {/* ─── Screenshots ─── */}
      <section id="screenshots" className="py-20 lg:py-28 bg-dark-900/30">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-14">
            <h2 className="text-3xl sm:text-4xl font-bold text-dark-50">
              {t('screenshots.title')}
            </h2>
            <p className="mt-4 text-dark-400 text-lg max-w-xl mx-auto">
              {t('screenshots.subtitle')}
            </p>
          </div>

          <div className="max-w-4xl mx-auto">
            <ScreenshotCarousel />
          </div>
        </div>
      </section>

      {/* ─── How it works ─── */}
      <section className="py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-dark-50">
              {t('howItWorks.title')}
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-4xl mx-auto">
            {([
              { step: '01', titleKey: 'howItWorks.step1.title' as const, descKey: 'howItWorks.step1.desc' as const },
              { step: '02', titleKey: 'howItWorks.step2.title' as const, descKey: 'howItWorks.step2.desc' as const },
              { step: '03', titleKey: 'howItWorks.step3.title' as const, descKey: 'howItWorks.step3.desc' as const },
            ]).map(item => (
              <div key={item.step} className="text-center">
                <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 border border-indigo-500/20 mb-5">
                  <span className="text-xl font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">{item.step}</span>
                </div>
                <h3 className="text-lg font-semibold text-dark-100 mb-3">{t(item.titleKey)}</h3>
                <p className="text-dark-400 text-sm leading-relaxed">{t(item.descKey)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── CTA ─── */}
      <section className="py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6">
          <div className="relative rounded-2xl overflow-hidden">
            {/* Background */}
            <div className="absolute inset-0 bg-gradient-to-r from-indigo-500/10 to-purple-500/10 border border-indigo-500/20 rounded-2xl" />
            <div className="absolute top-0 right-0 w-64 h-64 bg-purple-500/10 rounded-full blur-[80px]" />
            <div className="absolute bottom-0 left-0 w-64 h-64 bg-indigo-500/10 rounded-full blur-[80px]" />

            <div className="relative px-8 py-16 sm:px-16">
              <h2 className="text-3xl sm:text-4xl font-bold text-dark-50 text-center">
                {t('bottomCta.title')}
              </h2>
              <p className="mt-4 text-dark-400 text-lg max-w-xl mx-auto text-center">
                {t('bottomCta.subtitle')}
              </p>
              <div className="mt-10 grid grid-cols-1 md:grid-cols-3 gap-4 max-w-4xl mx-auto text-left">
                <CtaOptionCard
                  icon={Mail}
                  title={t('cta.contact.title')}
                  desc={t('cta.contact.descShort')}
                  onClick={() => setContactModal({ open: true, type: 'contact' })}
                  ctaLabel={t('cta.getStarted')}
                  accent
                />
                <CtaOptionCard
                  icon={Github}
                  title={t('cta.selfDeploy.title')}
                  desc={t('cta.selfDeploy.descShort')}
                  href="https://github.com/gvinsot/PulsarTeam"
                  ctaLabel={t('cta.viewOnGithub')}
                />
                <CtaOptionCard
                  icon={Headphones}
                  title={t('cta.support.title')}
                  desc={t('cta.support.descShort')}
                  onClick={() => setContactModal({ open: true, type: 'support' })}
                  ctaLabel={t('cta.getStarted')}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Footer ─── */}
      <footer className="border-t border-dark-800/80 py-8">
        <div className="max-w-7xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Logo size="sm" />
            <span className="text-sm font-semibold text-dark-300">PulsarTeam</span>
          </div>
          <p className="text-dark-500 text-xs">
            {t('footer.tagline')}
          </p>
          <div className="flex items-center gap-4">
            <button onClick={() => setLegalPage('terms')} className="text-dark-500 hover:text-dark-300 text-xs transition-colors">
              {t('footer.terms')}
            </button>
            <button onClick={() => setLegalPage('privacy')} className="text-dark-500 hover:text-dark-300 text-xs transition-colors">
              {t('footer.privacy')}
            </button>
          </div>
        </div>
      </footer>

      {/* ─── Login panel ─── */}
      <LoginPanel
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        onLogin={onLogin}
        onGoogleLogin={googleEnabled ? handleGoogleLogin : null}
        googleLoading={googleBusy || googleLoading}
      />

      {/* ─── Contact / Support form modal ─── */}
      <ContactFormModal
        open={contactModal.open}
        onClose={() => setContactModal(m => ({ ...m, open: false }))}
        type={contactModal.type}
      />
    </div>
  );
}
