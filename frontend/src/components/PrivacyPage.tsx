import { ArrowLeft } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';

const content = {
  en: {
    title: 'Data & Privacy Policy',
    lastUpdated: 'Last updated: May 2025',
    sections: [
      {
        heading: '1. Introduction',
        text: 'PulsarTeam is committed to protecting your privacy and personal data. This policy describes what data we collect, how we use it, and your rights regarding your information. This policy applies to all users of the PulsarTeam platform, whether hosted by us or self-deployed.'
      },
      {
        heading: '2. Data Controller',
        text: 'For hosted instances, the data controller is the PulsarTeam organization. For self-hosted deployments, the deploying organization acts as the data controller and is responsible for compliance with applicable data protection regulations (including GDPR).'
      },
      {
        heading: '3. Data We Collect',
        text: 'We collect and process the following categories of data:'
      },
      {
        heading: '3.1 Account Data',
        text: 'Username, email address, display name, and hashed password. If you sign in via Google OAuth, we receive your Google profile information (name, email, profile picture). This data is necessary to provide account access and authentication.'
      },
      {
        heading: '3.2 Project and Task Data',
        text: 'Project names, task descriptions, workflow configurations, board settings, and agent configurations that you create within the platform. This data is stored in PostgreSQL and is essential for the Service to function.'
      },
      {
        heading: '3.3 AI Agent Data',
        text: 'Conversation histories between you and AI agents, execution logs, tool call records, and agent memory files. This data is processed to enable AI agent functionality and is stored alongside your project data.'
      },
      {
        heading: '3.4 Integration Credentials',
        text: 'OAuth tokens and API keys for third-party services (GitHub, Jira, Slack, Gmail, OneDrive, Google Drive). These credentials are stored encrypted and are used solely to connect the Service to your external accounts as you configure them.'
      },
      {
        heading: '3.5 Usage and Log Data',
        text: 'Service logs, error reports, and operational metrics collected for monitoring and debugging purposes. These logs may include timestamps, IP addresses, and request metadata. Log data is retained for a limited period and automatically purged.'
      },
      {
        heading: '4. How We Use Your Data',
        text: 'We use your data exclusively to: (a) provide, maintain, and improve the Service; (b) authenticate your identity and manage your account; (c) execute AI agent tasks and workflow automation as you configure them; (d) connect to third-party services on your behalf; (e) monitor service health and diagnose issues; (f) communicate with you about the Service (security notices, updates).'
      },
      {
        heading: '5. Data Shared with Third Parties',
        text: 'When you configure AI agents with specific LLM providers (Anthropic, OpenAI, Mistral, etc.), your prompts and agent instructions are sent to these providers for processing. Each provider has its own privacy policy governing how it handles this data. We do not sell, rent, or share your personal data with third parties for marketing purposes. For self-hosted deployments, data flows directly between your infrastructure and the LLM providers you configure — PulsarTeam has no access to this data.'
      },
      {
        heading: '6. Data Storage and Security',
        text: 'Data is stored in PostgreSQL databases and on the file system of the hosting infrastructure. We implement industry-standard security measures including: encrypted credentials storage, secure authentication with JWT tokens, role-based access control, sandboxed agent execution environments, and configurable tool hooks for security rules. For self-hosted deployments, data security is the responsibility of the deploying organization.'
      },
      {
        heading: '7. Data Retention',
        text: 'Account data is retained for the duration of your account. Project and task data is retained until you delete it or close your account. Conversation histories and execution logs are retained as part of task history and may be subject to automatic compaction to manage storage. Log data for monitoring purposes is automatically purged after 30 days.'
      },
      {
        heading: '8. Your Rights (GDPR)',
        text: 'If you are located in the European Economic Area, you have the following rights under GDPR: (a) Right of access — request a copy of your personal data; (b) Right to rectification — request correction of inaccurate data; (c) Right to erasure — request deletion of your data; (d) Right to data portability — receive your data in a structured, machine-readable format; (e) Right to restrict processing — request limitation of how we use your data; (f) Right to object — object to data processing in certain circumstances. To exercise these rights, contact us through the application support channel or the contact form.'
      },
      {
        heading: '9. Cookies',
        text: 'The Service uses a JWT token stored in localStorage for authentication. We do not use tracking cookies or third-party analytics cookies. No cookie consent banner is required as we do not perform cross-site tracking.'
      },
      {
        heading: '10. Children\'s Privacy',
        text: 'The Service is not directed to individuals under the age of 16. We do not knowingly collect personal data from children. If we become aware that we have collected data from a child under 16, we will take steps to delete it promptly.'
      },
      {
        heading: '11. Changes to This Policy',
        text: 'We may update this privacy policy from time to time. Changes will be communicated through the Service interface. We encourage you to review this policy periodically.'
      },
      {
        heading: '12. Contact',
        text: 'For any questions about this privacy policy or to exercise your data rights, please contact us through the contact form on the PulsarTeam website or via the support channel in the application.'
      }
    ]
  },
  fr: {
    title: 'Politique de Données & Confidentialité',
    lastUpdated: 'Dernière mise à jour : mai 2025',
    sections: [
      {
        heading: '1. Introduction',
        text: 'PulsarTeam s\'engage à protéger votre vie privée et vos données personnelles. Cette politique décrit les données que nous collectons, comment nous les utilisons et vos droits concernant vos informations. Cette politique s\'applique à tous les utilisateurs de la plateforme PulsarTeam, qu\'elle soit hébergée par nous ou auto-déployée.'
      },
      {
        heading: '2. Responsable du traitement',
        text: 'Pour les instances hébergées, le responsable du traitement est l\'organisation PulsarTeam. Pour les déploiements auto-hébergés, l\'organisation qui déploie le Service agit en tant que responsable du traitement et est responsable de la conformité avec les réglementations applicables en matière de protection des données (y compris le RGPD).'
      },
      {
        heading: '3. Données que nous collectons',
        text: 'Nous collectons et traitons les catégories de données suivantes :'
      },
      {
        heading: '3.1 Données de compte',
        text: 'Nom d\'utilisateur, adresse e-mail, nom d\'affichage et mot de passe haché. Si vous vous connectez via Google OAuth, nous recevons vos informations de profil Google (nom, e-mail, photo de profil). Ces données sont nécessaires pour fournir l\'accès au compte et l\'authentification.'
      },
      {
        heading: '3.2 Données de projet et de tâches',
        text: 'Noms de projets, descriptions de tâches, configurations de workflow, paramètres de tableaux et configurations d\'agents que vous créez dans la plateforme. Ces données sont stockées dans PostgreSQL et sont essentielles au fonctionnement du Service.'
      },
      {
        heading: '3.3 Données des agents IA',
        text: 'Historiques de conversation entre vous et les agents IA, journaux d\'exécution, enregistrements d\'appels d\'outils et fichiers de mémoire des agents. Ces données sont traitées pour permettre le fonctionnement des agents IA et sont stockées avec vos données de projet.'
      },
      {
        heading: '3.4 Identifiants d\'intégration',
        text: 'Jetons OAuth et clés API pour les services tiers (GitHub, Jira, Slack, Gmail, OneDrive, Google Drive). Ces identifiants sont stockés de manière chiffrée et sont utilisés uniquement pour connecter le Service à vos comptes externes selon votre configuration.'
      },
      {
        heading: '3.5 Données d\'utilisation et journaux',
        text: 'Journaux de service, rapports d\'erreurs et métriques opérationnelles collectés à des fins de surveillance et de débogage. Ces journaux peuvent inclure des horodatages, des adresses IP et des métadonnées de requêtes. Les données de journalisation sont conservées pour une durée limitée et automatiquement purgées.'
      },
      {
        heading: '4. Comment nous utilisons vos données',
        text: 'Nous utilisons vos données exclusivement pour : (a) fournir, maintenir et améliorer le Service ; (b) authentifier votre identité et gérer votre compte ; (c) exécuter les tâches des agents IA et l\'automatisation des workflows selon votre configuration ; (d) se connecter aux services tiers en votre nom ; (e) surveiller la santé du service et diagnostiquer les problèmes ; (f) communiquer avec vous au sujet du Service (avis de sécurité, mises à jour).'
      },
      {
        heading: '5. Données partagées avec des tiers',
        text: 'Lorsque vous configurez des agents IA avec des fournisseurs de LLM spécifiques (Anthropic, OpenAI, Mistral, etc.), vos prompts et instructions d\'agents sont envoyés à ces fournisseurs pour traitement. Chaque fournisseur a sa propre politique de confidentialité régissant le traitement de ces données. Nous ne vendons, ne louons et ne partageons pas vos données personnelles avec des tiers à des fins marketing. Pour les déploiements auto-hébergés, les données circulent directement entre votre infrastructure et les fournisseurs de LLM que vous configurez — PulsarTeam n\'a aucun accès à ces données.'
      },
      {
        heading: '6. Stockage et sécurité des données',
        text: 'Les données sont stockées dans des bases de données PostgreSQL et sur le système de fichiers de l\'infrastructure d\'hébergement. Nous mettons en œuvre des mesures de sécurité conformes aux standards de l\'industrie, notamment : stockage chiffré des identifiants, authentification sécurisée par jetons JWT, contrôle d\'accès basé sur les rôles, environnements d\'exécution sandboxés pour les agents et hooks d\'outils configurables pour les règles de sécurité. Pour les déploiements auto-hébergés, la sécurité des données est la responsabilité de l\'organisation déployant le Service.'
      },
      {
        heading: '7. Conservation des données',
        text: 'Les données de compte sont conservées pendant la durée de votre compte. Les données de projet et de tâches sont conservées jusqu\'à ce que vous les supprimiez ou fermiez votre compte. Les historiques de conversation et les journaux d\'exécution sont conservés dans le cadre de l\'historique des tâches et peuvent être soumis à une compaction automatique pour gérer le stockage. Les données de journalisation à des fins de surveillance sont automatiquement purgées après 30 jours.'
      },
      {
        heading: '8. Vos droits (RGPD)',
        text: 'Si vous êtes situé dans l\'Espace économique européen, vous disposez des droits suivants en vertu du RGPD : (a) Droit d\'accès — demander une copie de vos données personnelles ; (b) Droit de rectification — demander la correction de données inexactes ; (c) Droit à l\'effacement — demander la suppression de vos données ; (d) Droit à la portabilité des données — recevoir vos données dans un format structuré et lisible par machine ; (e) Droit à la limitation du traitement — demander la limitation de l\'utilisation de vos données ; (f) Droit d\'opposition — s\'opposer au traitement des données dans certaines circonstances. Pour exercer ces droits, contactez-nous via le canal de support de l\'application ou le formulaire de contact.'
      },
      {
        heading: '9. Cookies',
        text: 'Le Service utilise un jeton JWT stocké dans le localStorage pour l\'authentification. Nous n\'utilisons pas de cookies de suivi ni de cookies d\'analyse tiers. Aucune bannière de consentement aux cookies n\'est requise car nous n\'effectuons pas de suivi intersite.'
      },
      {
        heading: '10. Données des mineurs',
        text: 'Le Service ne s\'adresse pas aux personnes de moins de 16 ans. Nous ne collectons pas sciemment de données personnelles auprès d\'enfants. Si nous apprenons que nous avons collecté des données d\'un enfant de moins de 16 ans, nous prendrons des mesures pour les supprimer rapidement.'
      },
      {
        heading: '11. Modifications de cette politique',
        text: 'Nous pouvons mettre à jour cette politique de confidentialité de temps à autre. Les modifications seront communiquées via l\'interface du Service. Nous vous encourageons à consulter cette politique régulièrement.'
      },
      {
        heading: '12. Contact',
        text: 'Pour toute question relative à cette politique de confidentialité ou pour exercer vos droits sur vos données, veuillez nous contacter via le formulaire de contact sur le site web de PulsarTeam ou via le canal de support dans l\'application.'
      }
    ]
  }
};

export default function PrivacyPage({ onBack }: { onBack: () => void }) {
  const { lang } = useLanguage();
  const c = content[lang];

  return (
    <div className="min-h-screen bg-dark-950 text-dark-200">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-sm text-dark-400 hover:text-dark-200 transition-colors mb-8"
        >
          <ArrowLeft className="w-4 h-4" />
          {lang === 'fr' ? 'Retour' : 'Back'}
        </button>

        <h1 className="text-3xl font-bold text-dark-50 mb-2">{c.title}</h1>
        <p className="text-dark-500 text-sm mb-12">{c.lastUpdated}</p>

        <div className="space-y-8">
          {c.sections.map((s, i) => (
            <section key={i}>
              <h2 className="text-lg font-semibold text-dark-100 mb-3">{s.heading}</h2>
              <p className="text-dark-400 leading-relaxed">{s.text}</p>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
