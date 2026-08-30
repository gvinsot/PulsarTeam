import { useState } from 'react';
import {
  Sparkles,
  FileText,
  Bot,
  ListChecks,
  Workflow,
  ArrowRight,
  ArrowLeft,
  Check,
  LogOut,
} from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';
import { api } from '../api';
import { errorMessage } from '../utils/errors';
import type { ShowToastFn } from '../types';

type Lang = 'en' | 'fr';

const COPY: Record<Lang, any> = {
  en: {
    welcomeTitle: 'Welcome to PulsarTeam',
    welcomeIntro:
      'A multi-agent orchestration platform where AI agents run autonomously on your projects, organised through Kanban workflows you control.',
    termsHeading: 'Before you start, please accept our Terms & Conditions',
    termsSummary:
      'You are responsible for the actions your agents take, including code commits and external integrations. PulsarTeam provides safety hooks but the final responsibility lies with you. By accepting, you agree to use the platform lawfully and acknowledge that your acceptance date will be stored.',
    readFull: 'Read the full Terms and Conditions',
    acceptCheckbox: 'I have read and accept the Terms and Conditions',
    accept: 'Accept and continue',
    declineLogout: 'Decline and sign out',
    tutorialTitle: 'Quick tour',
    tutorialIntro: 'Here is how PulsarTeam works in three steps.',
    step: (n: number, total: number) => `Step ${n} of ${total}`,
    steps: [
      {
        icon: Bot,
        title: 'Create your first agent',
        body: 'Open the Agents tab and click "Add Agent". Pick a role, give it a name and choose a model — the agent will be ready to receive tasks.',
      },
      {
        icon: Workflow,
        title: 'Set up a workflow',
        body: 'In the Workflows tab, configure the columns of your Kanban (e.g. backlog → code → review → done). Workflows belong to a board and define how tasks progress.',
      },
      {
        icon: ListChecks,
        title: 'Add tasks for your agents',
        body: 'Drop a task into the first column — describe what you want, optionally assign it to an agent. Agents will pick it up, work on it, and move it through the columns autonomously.',
      },
    ],
    previous: 'Previous',
    next: 'Next',
    finish: 'Got it — let me start',
    saving: 'Saving…',
  },
  fr: {
    welcomeTitle: 'Bienvenue sur PulsarTeam',
    welcomeIntro:
      "Une plateforme d'orchestration multi-agents : vos agents IA travaillent de manière autonome sur vos projets, organisés par des workflows Kanban que vous contrôlez.",
    termsHeading: "Avant de commencer, merci d'accepter les Conditions Générales d'Utilisation",
    termsSummary:
      "Vous êtes responsable des actions de vos agents, y compris des commits de code et des intégrations externes. PulsarTeam fournit des garde-fous, mais la responsabilité finale vous incombe. En acceptant, vous reconnaissez utiliser la plateforme de manière licite et que la date d'acceptation sera enregistrée.",
    readFull: "Lire les Conditions Générales d'Utilisation complètes",
    acceptCheckbox: "J'ai lu et j'accepte les Conditions Générales d'Utilisation",
    accept: 'Accepter et continuer',
    declineLogout: 'Refuser et se déconnecter',
    tutorialTitle: 'Visite rapide',
    tutorialIntro: 'Voici comment fonctionne PulsarTeam en trois étapes.',
    step: (n: number, total: number) => `Étape ${n} sur ${total}`,
    steps: [
      {
        icon: Bot,
        title: 'Créez votre premier agent',
        body: 'Allez dans l\'onglet Agents et cliquez sur "Ajouter un agent". Choisissez un rôle, un nom et un modèle — votre agent sera prêt à recevoir des tâches.',
      },
      {
        icon: Workflow,
        title: 'Configurez un workflow',
        body: "Dans l'onglet Workflows, paramétrez les colonnes de votre Kanban (par ex. backlog → code → review → done). Un workflow appartient à un board et définit la progression des tâches.",
      },
      {
        icon: ListChecks,
        title: 'Ajoutez des tâches à vos agents',
        body: 'Déposez une tâche dans la première colonne — décrivez ce que vous voulez, et assignez-la éventuellement à un agent. Les agents la prendront en charge et la feront progresser dans les colonnes de manière autonome.',
      },
    ],
    previous: 'Précédent',
    next: 'Suivant',
    finish: "C'est compris — je commence",
    saving: 'Enregistrement…',
  },
};

interface Props {
  needTerms: boolean;
  needTutorial: boolean;
  onTermsAccepted: () => void;
  onTutorialCompleted: () => void;
  onDeclineLogout: () => void;
  showToast?: ShowToastFn;
}

export default function WelcomeTutorialModal({
  needTerms,
  needTutorial,
  onTermsAccepted,
  onTutorialCompleted,
  onDeclineLogout,
  showToast,
}: Props) {
  const { lang } = useLanguage();
  const c = COPY[lang];
  const [phase, setPhase] = useState<'terms' | 'tutorial'>(needTerms ? 'terms' : 'tutorial');
  const [accepted, setAccepted] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [saving, setSaving] = useState(false);

  const totalSteps = c.steps.length;

  const handleAccept = async () => {
    if (!accepted || saving) return;
    setSaving(true);
    try {
      await api.acceptTerms();
      onTermsAccepted();
      if (needTutorial) {
        setPhase('tutorial');
      } else {
        // No tutorial needed (already completed), just close
        onTutorialCompleted();
      }
    } catch (err) {
      showToast?.(errorMessage(err) || 'Failed to record acceptance', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleNext = () => {
    if (stepIndex < totalSteps - 1) {
      setStepIndex(stepIndex + 1);
    } else {
      handleFinish();
    }
  };

  const handleFinish = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api.completeTutorial();
    } catch {
      // Non-blocking — tutorial completion is a UX-only flag
    } finally {
      setSaving(false);
      onTutorialCompleted();
    }
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-dark-900 border border-dark-700 rounded-xl shadow-2xl max-w-2xl w-full my-8 overflow-hidden">
        {phase === 'terms' ? (
          <>
            <div className="px-8 pt-8 pb-6 border-b border-dark-700 bg-gradient-to-br from-indigo-500/10 to-purple-500/10">
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2.5 bg-indigo-500/20 rounded-lg">
                  <Sparkles className="w-6 h-6 text-indigo-400" />
                </div>
                <h2 className="text-2xl font-bold text-dark-50">{c.welcomeTitle}</h2>
              </div>
              <p className="text-dark-300 leading-relaxed">{c.welcomeIntro}</p>
            </div>

            <div className="px-8 py-6 space-y-5">
              <div className="flex items-start gap-3">
                <FileText className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-base font-semibold text-dark-100 mb-2">{c.termsHeading}</h3>
                  <p className="text-sm text-dark-400 leading-relaxed">{c.termsSummary}</p>
                </div>
              </div>

              <a
                href="/terms"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                <FileText className="w-4 h-4" />
                {c.readFull}
              </a>

              <label className="flex items-start gap-3 cursor-pointer select-none p-3 rounded-lg border border-dark-700 hover:border-dark-600 transition-colors">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={e => setAccepted(e.target.checked)}
                  className="mt-0.5 w-4 h-4 accent-indigo-500"
                />
                <span className="text-sm text-dark-200">{c.acceptCheckbox}</span>
              </label>
            </div>

            <div className="px-8 py-5 border-t border-dark-700 flex items-center justify-between gap-3 bg-dark-950/50">
              <button
                onClick={onDeclineLogout}
                disabled={saving}
                className="flex items-center gap-2 text-sm text-dark-400 hover:text-red-400 transition-colors disabled:opacity-50"
              >
                <LogOut className="w-4 h-4" />
                {c.declineLogout}
              </button>
              <button
                onClick={handleAccept}
                disabled={!accepted || saving}
                className="flex items-center gap-2 px-5 py-2.5 bg-indigo-500 hover:bg-indigo-600 disabled:bg-dark-700 disabled:text-dark-500 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {saving ? (
                  c.saving
                ) : (
                  <>
                    <Check className="w-4 h-4" />
                    {c.accept}
                  </>
                )}
              </button>
            </div>
          </>
        ) : (
          <TutorialBody
            copy={c}
            stepIndex={stepIndex}
            totalSteps={totalSteps}
            saving={saving}
            onPrev={() => setStepIndex(Math.max(0, stepIndex - 1))}
            onNext={handleNext}
          />
        )}
      </div>
    </div>
  );
}

function TutorialBody({ copy, stepIndex, totalSteps, saving, onPrev, onNext }: any) {
  const step = copy.steps[stepIndex];
  const Icon = step.icon;
  const isLast = stepIndex === totalSteps - 1;

  return (
    <>
      <div className="px-8 pt-8 pb-5 border-b border-dark-700 bg-gradient-to-br from-emerald-500/10 to-indigo-500/10">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2.5 bg-emerald-500/20 rounded-lg">
            <Sparkles className="w-6 h-6 text-emerald-400" />
          </div>
          <h2 className="text-2xl font-bold text-dark-50">{copy.tutorialTitle}</h2>
        </div>
        <p className="text-dark-300 text-sm">{copy.tutorialIntro}</p>
      </div>

      <div className="px-8 py-8">
        <div className="text-xs uppercase tracking-wider text-dark-500 mb-3">
          {copy.step(stepIndex + 1, totalSteps)}
        </div>

        <div className="flex items-start gap-4 mb-6">
          <div className="p-3 bg-indigo-500/15 rounded-xl flex-shrink-0">
            <Icon className="w-7 h-7 text-indigo-400" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-dark-50 mb-2">{step.title}</h3>
            <p className="text-sm text-dark-300 leading-relaxed">{step.body}</p>
          </div>
        </div>

        <div className="flex items-center justify-center gap-2 mt-8">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === stepIndex
                  ? 'w-8 bg-indigo-500'
                  : i < stepIndex
                    ? 'w-1.5 bg-indigo-500/60'
                    : 'w-1.5 bg-dark-700'
              }`}
            />
          ))}
        </div>
      </div>

      <div className="px-8 py-5 border-t border-dark-700 flex items-center justify-between gap-3 bg-dark-950/50">
        <button
          onClick={onPrev}
          disabled={stepIndex === 0 || saving}
          className="flex items-center gap-2 px-4 py-2 text-sm text-dark-300 hover:text-dark-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          {copy.previous}
        </button>

        <button
          onClick={onNext}
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2.5 bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-60"
        >
          {saving ? (
            copy.saving
          ) : isLast ? (
            <>
              <Check className="w-4 h-4" />
              {copy.finish}
            </>
          ) : (
            <>
              {copy.next}
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </div>
    </>
  );
}
