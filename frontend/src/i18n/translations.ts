export type Lang = 'en' | 'fr';

const translations = {
  // Navbar
  'nav.features': { en: 'Features', fr: 'Fonctionnalités' },
  'nav.product': { en: 'Product', fr: 'Produit' },
  'nav.signIn': { en: 'Sign In', fr: 'Connexion' },

  // Hero
  'hero.badge': { en: 'Multi-Agent Orchestration Platform', fr: 'Plateforme d\'orchestration multi-agents' },
  'hero.title.part1': { en: 'Your AI Team,', fr: 'Votre équipe IA,' },
  'hero.title.highlight': { en: 'Orchestrated', fr: 'Orchestrée' },
  'hero.subtitle': {
    en: 'Deploy, coordinate, and monitor autonomous AI agents working together on your projects. Built for teams who need real results, not just conversations.',
    fr: 'Déployez, coordonnez et supervisez des agents IA autonomes travaillant ensemble sur vos projets. Conçu pour les équipes qui veulent des résultats concrets.',
  },

  // CTA cards
  'cta.contact.title': { en: 'Free to Test', fr: 'Essai gratuit' },
  'cta.contact.desc': {
    en: 'Try PulsarTeam free for 15 days with 1 AI agent. Just log in — no credit card required.',
    fr: 'Essayez PulsarTeam gratuitement pendant 15 jours avec 1 agent IA. Connectez-vous, c\'est tout — aucune carte bancaire requise.',
  },
  'cta.contact.descShort': {
    en: '15 days free with 1 AI agent. Just log in!',
    fr: '15 jours gratuits avec 1 agent IA. Connectez-vous !',
  },
  'cta.enterprise.title': { en: 'Enterprise', fr: 'Entreprise' },
  'cta.enterprise.desc': {
    en: 'Dedicated instance, custom integrations, SLA and priority support for your organization.',
    fr: 'Instance dédiée, intégrations sur mesure, SLA et support prioritaire pour votre organisation.',
  },
  'cta.enterprise.descShort': {
    en: 'Dedicated instance with SLA and priority support.',
    fr: 'Instance dédiée avec SLA et support prioritaire.',
  },
  'cta.support.title': { en: 'Request Support', fr: 'Demander du support' },
  'cta.support.desc': {
    en: 'Already running PulsarTeam? Get expert support from our team.',
    fr: 'Vous utilisez déjà PulsarTeam ? Bénéficiez du support de notre équipe.',
  },
  'cta.support.descShort': {
    en: 'Get expert help for your instance.',
    fr: 'Obtenez l\'aide d\'experts pour votre instance.',
  },
  'cta.contactUs': { en: 'Contact us', fr: 'Nous contacter' },
  'cta.getStarted': { en: 'Get started', fr: 'Commencer' },
  'cta.tryFree': { en: 'Try it free', fr: 'Essayer gratuitement' },

  // Features section
  'features.title': { en: 'Everything you need to run an AI team', fr: 'Tout ce qu\'il faut pour gérer une équipe IA' },
  'features.subtitle': {
    en: 'From agent management to cost monitoring, PulsarTeam gives you full control over your autonomous workforce.',
    fr: 'De la gestion des agents au suivi des coûts, PulsarTeam vous donne un contrôle total sur vos agents autonomes.',
  },
  'features.agentMgmt.title': { en: 'Agent Management', fr: 'Gestion des agents' },
  'features.agentMgmt.desc': {
    en: 'Create and configure AI agents with custom prompts, models, and capabilities. Monitor status, messages, and token usage in real time.',
    fr: 'Créez et configurez des agents IA avec des prompts, modèles et capacités personnalisés. Surveillez leur statut, messages et utilisation de tokens en temps réel.',
  },
  'features.kanban.title': { en: 'Kanban Task Boards', fr: 'Tableaux Kanban' },
  'features.kanban.desc': {
    en: 'Organize work with drag-and-drop boards. Agents pick up tasks, execute them autonomously, and report results as they progress.',
    fr: 'Organisez le travail avec des tableaux drag-and-drop. Les agents prennent les tâches, les exécutent et rapportent leurs résultats au fur et à mesure.',
  },
  'features.projects.title': { en: 'Project Workspaces', fr: 'Espaces de projets' },
  'features.projects.desc': {
    en: 'Scope agents to projects with objectives, rules, and context. Track progress with statistics, charts, and resolution metrics.',
    fr: 'Associez les agents à des projets avec objectifs, règles et contexte. Suivez la progression avec statistiques, graphiques et métriques.',
  },
  'features.budget.title': { en: 'Budget Control', fr: 'Contrôle budgétaire' },
  'features.budget.desc': {
    en: 'Set spending limits per model. Track daily costs, token breakdown, and usage trends with real-time dashboards.',
    fr: 'Définissez des limites de dépenses par modèle. Suivez les coûts quotidiens et l\'utilisation des tokens avec des tableaux de bord en temps réel.',
  },
  'features.swarm.title': { en: 'Swarm Orchestration', fr: 'Orchestration en essaim' },
  'features.swarm.desc': {
    en: 'Agents delegate tasks to each other, hand off context, and collaborate. The Swarm Leader coordinates complex multi-step workflows.',
    fr: 'Les agents se délèguent des tâches, transmettent le contexte et collaborent. Le Swarm Leader coordonne les workflows complexes.',
  },
  'features.multiProvider.title': { en: 'Multi-Provider', fr: 'Multi-fournisseur' },
  'features.multiProvider.desc': {
    en: 'Connect any LLM provider: Anthropic Claude, OpenAI GPT, Mistral, Ollama, vLLM, Google. Switch models per agent without code changes.',
    fr: 'Connectez n\'importe quel fournisseur LLM : Anthropic Claude, OpenAI GPT, Mistral, Ollama, vLLM, Google. Changez de modèle par agent sans modifier le code.',
  },
  'features.sandbox.title': { en: 'Sandboxed Execution', fr: 'Exécution isolée' },
  'features.sandbox.desc': {
    en: 'Agents run code in isolated Docker containers with full dev environments. Git, Node, Python, Go, and more out of the box.',
    fr: 'Les agents exécutent du code dans des conteneurs Docker isolés avec des environnements de développement complets. Git, Node, Python, Go et plus.',
  },
  'features.plugins.title': { en: 'Plugins & MCP', fr: 'Plugins & MCP' },
  'features.plugins.desc': {
    en: 'Extend agents with plugins and Model Context Protocol servers. Connect to Slack, OneDrive, databases, or any custom tool.',
    fr: 'Étendez les agents avec des plugins et des serveurs MCP. Connectez-les à Slack, OneDrive, des bases de données ou tout outil personnalisé.',
  },
  'features.openSource.title': { en: 'Open Source', fr: 'Open Source' },
  'features.openSource.desc': {
    en: 'Self-host on your infrastructure. Full control over data, models, and configuration. Licensed under AGPL-3.0.',
    fr: 'Hébergez sur votre infrastructure. Contrôle total sur les données, modèles et configuration. Sous licence AGPL-3.0.',
  },

  // Screenshots
  'screenshots.title': { en: 'See it in action', fr: 'Voyez-le en action' },
  'screenshots.subtitle': {
    en: 'A modern, responsive interface designed for managing complex AI workflows.',
    fr: 'Une interface moderne et responsive conçue pour gérer des workflows IA complexes.',
  },
  'screenshots.agents.label': { en: 'Agent Management', fr: 'Gestion des agents' },
  'screenshots.agents.caption': {
    en: 'Monitor and manage your AI agents in real time with detailed metrics and status indicators.',
    fr: 'Surveillez et gérez vos agents IA en temps réel avec des métriques détaillées et des indicateurs de statut.',
  },
  'screenshots.tasks.label': { en: 'Kanban Board', fr: 'Tableau Kanban' },
  'screenshots.tasks.caption': {
    en: 'Organize work across customizable boards with drag-and-drop columns and agent assignments.',
    fr: 'Organisez le travail sur des tableaux personnalisables avec des colonnes drag-and-drop et l\'assignation d\'agents.',
  },
  'screenshots.projects.label': { en: 'Project Analytics', fr: 'Analytique de projets' },
  'screenshots.projects.caption': {
    en: 'Track project progress with detailed statistics, resolution times, and ticket trends.',
    fr: 'Suivez la progression des projets avec des statistiques détaillées, des temps de résolution et des tendances.',
  },
  'screenshots.budget.label': { en: 'Cost Control', fr: 'Contrôle des coûts' },
  'screenshots.budget.caption': {
    en: 'Monitor spending by model, track daily costs against budgets, and optimize token usage.',
    fr: 'Surveillez les dépenses par modèle, suivez les coûts quotidiens et optimisez l\'utilisation des tokens.',
  },

  // How it works
  'howItWorks.title': { en: 'How it works', fr: 'Comment ça fonctionne' },
  'howItWorks.step1.title': { en: 'Configure Agents', fr: 'Configurez les agents' },
  'howItWorks.step1.desc': {
    en: 'Choose models, set system prompts, assign plugins and tools. Each agent gets its own sandboxed workspace.',
    fr: 'Choisissez les modèles, définissez les prompts système, assignez des plugins et outils. Chaque agent a son propre espace de travail isolé.',
  },
  'howItWorks.step2.title': { en: 'Create Workflows', fr: 'Créez les workflows' },
  'howItWorks.step2.desc': {
    en: 'Add tasks to your Kanban board. Assign them to agents or let the Swarm Leader delegate automatically.',
    fr: 'Ajoutez des tâches à votre tableau Kanban. Assignez-les aux agents ou laissez le Swarm Leader les déléguer automatiquement.',
  },
  'howItWorks.step3.title': { en: 'Monitor & Ship', fr: 'Supervisez et livrez' },
  'howItWorks.step3.desc': {
    en: 'Watch agents work in real time. Review code, track costs, and merge results. Ship faster than ever.',
    fr: 'Observez les agents travailler en temps réel. Relisez le code, suivez les coûts et mergez les résultats. Livrez plus vite que jamais.',
  },

  // Bottom CTA
  'bottomCta.title': { en: 'Ready to orchestrate your AI team?', fr: 'Prêt à orchestrer votre équipe IA ?' },
  'bottomCta.subtitle': {
    en: 'Choose how you want to get started with PulsarTeam.',
    fr: 'Choisissez comment démarrer avec PulsarTeam.',
  },

  // Footer
  'footer.tagline': {
    en: 'Open-source multi-agent orchestration platform. Licensed under AGPL-3.0.',
    fr: 'Plateforme open-source d\'orchestration multi-agents. Sous licence AGPL-3.0.',
  },
  'footer.terms': { en: 'Terms and Conditions', fr: 'Conditions générales' },
  'footer.privacy': { en: 'Data & Privacy', fr: 'Données & Confidentialité' },

  // Login panel
  'login.title': { en: 'Sign In', fr: 'Connexion' },
  'login.username': { en: 'Username', fr: 'Nom d\'utilisateur' },
  'login.usernamePlaceholder': { en: 'Enter username', fr: 'Entrez votre nom d\'utilisateur' },
  'login.password': { en: 'Password', fr: 'Mot de passe' },
  'login.passwordPlaceholder': { en: 'Enter password', fr: 'Entrez votre mot de passe' },
  'login.submit': { en: 'Sign In', fr: 'Se connecter' },
  'login.connecting': { en: 'Connecting...', fr: 'Connexion...' },
  'login.or': { en: 'or', fr: 'ou' },
  'login.google': { en: 'Sign in with Google', fr: 'Se connecter avec Google' },
  'login.microsoft': { en: 'Sign in with Microsoft', fr: 'Se connecter avec Microsoft' },
  'login.oauthRedirecting': { en: 'Redirecting...', fr: 'Redirection...' },
  'login.secure': { en: 'Secure multi-agent management interface', fr: 'Interface sécurisée de gestion multi-agents' },

  // Contact form
  'contact.title': { en: 'Contact Us', fr: 'Nous contacter' },
  'contact.titleSupport': { en: 'Request Support', fr: 'Demander du support' },
  'contact.subtitle': {
    en: 'Tell us about your needs and we\'ll help you set up PulsarTeam in your organization.',
    fr: 'Décrivez vos besoins et nous vous aiderons à mettre en place PulsarTeam dans votre organisation.',
  },
  'contact.subtitleSupport': {
    en: 'Describe your issue and our team will get back to you.',
    fr: 'Décrivez votre problème et notre équipe vous recontactera.',
  },
  'contact.name': { en: 'Name', fr: 'Nom' },
  'contact.namePlaceholder': { en: 'Your name', fr: 'Votre nom' },
  'contact.email': { en: 'Email', fr: 'Email' },
  'contact.emailPlaceholder': { en: 'you@company.com', fr: 'vous@entreprise.com' },
  'contact.phone': { en: 'Phone', fr: 'Téléphone' },
  'contact.phonePlaceholder': { en: '+33 6 12 34 56 78', fr: '+33 6 12 34 56 78' },
  'contact.company': { en: 'Company', fr: 'Entreprise' },
  'contact.companyPlaceholder': { en: 'Your company name', fr: 'Nom de votre entreprise' },
  'contact.message': { en: 'Message', fr: 'Message' },
  'contact.messagePlaceholder': {
    en: 'Tell us about your project and needs...',
    fr: 'Décrivez votre projet et vos besoins...',
  },
  'contact.messagePlaceholderSupport': {
    en: 'Describe the issue you need help with...',
    fr: 'Décrivez le problème pour lequel vous avez besoin d\'aide...',
  },
  'contact.submit': { en: 'Submit', fr: 'Envoyer' },
  'contact.sending': { en: 'Sending...', fr: 'Envoi...' },
  'contact.successTitle': { en: 'Request Submitted!', fr: 'Demande envoyée !' },
  'contact.successMessage': {
    en: 'We\'ll get back to you as soon as possible.',
    fr: 'Nous vous recontacterons dès que possible.',
  },
  'contact.close': { en: 'Close', fr: 'Fermer' },
} as const;

export type TranslationKey = keyof typeof translations;

export function t(key: TranslationKey, lang: Lang): string {
  const entry = translations[key];
  if (!entry) return key;
  return entry[lang] || entry['en'];
}

export default translations;
