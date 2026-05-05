import { ArrowLeft } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';

const content = {
  en: {
    title: 'Terms and Conditions',
    lastUpdated: 'Last updated: May 2025',
    sections: [
      {
        heading: '1. Acceptance of Terms',
        text: 'By accessing and using PulsarTeam ("the Service"), you agree to be bound by these Terms and Conditions. If you do not agree to these terms, you must not use the Service. These terms apply to all users, including individual users, team members, and organizations.'
      },
      {
        heading: '2. Description of the Service',
        text: 'PulsarTeam is a multi-agent orchestration platform that enables users to deploy, coordinate, and monitor autonomous AI agents working on software development projects. The Service includes agent management, task orchestration via Kanban boards, project tracking, plugin integrations, and budget monitoring features.'
      },
      {
        heading: '3. User Accounts',
        text: 'You are responsible for maintaining the confidentiality of your account credentials and for all activities that occur under your account. You must notify the administrator immediately of any unauthorized use. Each user account is personal and must not be shared. Administrators may create and manage user accounts and set appropriate access roles (admin or user).'
      },
      {
        heading: '4. Acceptable Use',
        text: 'You agree to use the Service only for lawful purposes and in accordance with these terms. You must not: (a) use the Service to execute malicious code or perform unauthorized actions on connected systems; (b) attempt to gain unauthorized access to other users\' accounts or data; (c) use AI agents to generate harmful, illegal, or infringing content; (d) overload the Service infrastructure intentionally; (e) reverse-engineer, decompile, or attempt to extract the source code of proprietary components.'
      },
      {
        heading: '5. AI Agents and Autonomous Execution',
        text: 'AI agents deployed through the Service operate autonomously based on instructions and workflow configurations you define. You are responsible for reviewing and validating the output produced by AI agents, including but not limited to code, commits, and automated actions. PulsarTeam provides tool hooks and security rules to help mitigate risks, but the final responsibility for agent behavior lies with the user. Agents may interact with external services (GitHub, Jira, Slack, etc.) based on the integrations you configure.'
      },
      {
        heading: '6. Intellectual Property',
        text: 'Content you create, upload, or generate through the Service remains your property. Code produced by AI agents on your behalf belongs to you, subject to the licenses of any dependencies or frameworks used. The PulsarTeam platform itself is licensed under AGPL-3.0. You retain all rights to your project data, task descriptions, and configuration settings.'
      },
      {
        heading: '7. Third-Party Integrations',
        text: 'The Service integrates with third-party providers including but not limited to: LLM providers (Anthropic Claude, OpenAI, Mistral, Ollama, vLLM), code repositories (GitHub), project management tools (Jira), communication platforms (Slack), cloud storage (OneDrive, Google Drive), and email services (Gmail). Your use of these integrations is subject to the respective third-party terms of service. PulsarTeam is not responsible for the availability, accuracy, or policies of third-party services.'
      },
      {
        heading: '8. Service Availability',
        text: 'We strive to maintain high availability of the Service but do not guarantee uninterrupted access. The Service may be temporarily unavailable for maintenance, updates, or due to circumstances beyond our control. For self-hosted deployments, availability is the responsibility of the deploying organization.'
      },
      {
        heading: '9. Limitation of Liability',
        text: 'To the maximum extent permitted by applicable law, PulsarTeam and its contributors shall not be liable for any indirect, incidental, special, consequential, or punitive damages resulting from your use of the Service, including but not limited to damages arising from AI agent actions, code deployments, data loss, or service interruptions.'
      },
      {
        heading: '10. Modifications to Terms',
        text: 'We reserve the right to modify these terms at any time. Changes will be communicated through the Service interface or via email. Continued use of the Service after changes are posted constitutes acceptance of the modified terms.'
      },
      {
        heading: '11. Termination',
        text: 'We may suspend or terminate your access to the Service at any time for violation of these terms. Upon termination, your right to use the Service ceases immediately. You may export your data before termination where technically feasible.'
      },
      {
        heading: '12. Governing Law',
        text: 'These terms are governed by and construed in accordance with the laws of France. Any disputes arising from these terms shall be subject to the exclusive jurisdiction of the courts of Paris, France.'
      },
      {
        heading: '13. Contact',
        text: 'For questions about these terms, please contact us through the contact form on the PulsarTeam website or via the support channel available in the application.'
      }
    ]
  },
  fr: {
    title: 'Conditions Générales d\'Utilisation',
    lastUpdated: 'Dernière mise à jour : mai 2025',
    sections: [
      {
        heading: '1. Acceptation des conditions',
        text: 'En accédant et en utilisant PulsarTeam (« le Service »), vous acceptez d\'être lié par les présentes Conditions Générales d\'Utilisation. Si vous n\'acceptez pas ces conditions, vous ne devez pas utiliser le Service. Ces conditions s\'appliquent à tous les utilisateurs, y compris les utilisateurs individuels, les membres d\'équipe et les organisations.'
      },
      {
        heading: '2. Description du Service',
        text: 'PulsarTeam est une plateforme d\'orchestration multi-agents qui permet aux utilisateurs de déployer, coordonner et superviser des agents IA autonomes travaillant sur des projets de développement logiciel. Le Service comprend la gestion des agents, l\'orchestration des tâches via des tableaux Kanban, le suivi des projets, les intégrations de plugins et le suivi budgétaire.'
      },
      {
        heading: '3. Comptes utilisateurs',
        text: 'Vous êtes responsable de la confidentialité de vos identifiants de compte et de toutes les activités réalisées sous votre compte. Vous devez notifier immédiatement l\'administrateur de toute utilisation non autorisée. Chaque compte utilisateur est personnel et ne doit pas être partagé. Les administrateurs peuvent créer et gérer les comptes utilisateurs et définir les rôles d\'accès appropriés (administrateur ou utilisateur).'
      },
      {
        heading: '4. Utilisation acceptable',
        text: 'Vous acceptez d\'utiliser le Service uniquement à des fins licites et conformément aux présentes conditions. Vous ne devez pas : (a) utiliser le Service pour exécuter du code malveillant ou effectuer des actions non autorisées sur des systèmes connectés ; (b) tenter d\'accéder sans autorisation aux comptes ou données d\'autres utilisateurs ; (c) utiliser les agents IA pour générer du contenu nuisible, illégal ou contrefaisant ; (d) surcharger intentionnellement l\'infrastructure du Service ; (e) effectuer de l\'ingénierie inverse, décompiler ou tenter d\'extraire le code source des composants propriétaires.'
      },
      {
        heading: '5. Agents IA et exécution autonome',
        text: 'Les agents IA déployés via le Service fonctionnent de manière autonome selon les instructions et configurations de workflow que vous définissez. Vous êtes responsable de la révision et de la validation des résultats produits par les agents IA, y compris mais sans s\'y limiter, le code, les commits et les actions automatisées. PulsarTeam fournit des hooks d\'outils et des règles de sécurité pour aider à atténuer les risques, mais la responsabilité finale du comportement des agents incombe à l\'utilisateur. Les agents peuvent interagir avec des services externes (GitHub, Jira, Slack, etc.) en fonction des intégrations que vous configurez.'
      },
      {
        heading: '6. Propriété intellectuelle',
        text: 'Le contenu que vous créez, téléchargez ou générez via le Service reste votre propriété. Le code produit par les agents IA pour votre compte vous appartient, sous réserve des licences des dépendances ou frameworks utilisés. La plateforme PulsarTeam elle-même est sous licence AGPL-3.0. Vous conservez tous les droits sur vos données de projet, descriptions de tâches et paramètres de configuration.'
      },
      {
        heading: '7. Intégrations tierces',
        text: 'Le Service s\'intègre avec des fournisseurs tiers incluant, sans s\'y limiter : les fournisseurs de LLM (Anthropic Claude, OpenAI, Mistral, Ollama, vLLM), les dépôts de code (GitHub), les outils de gestion de projet (Jira), les plateformes de communication (Slack), le stockage cloud (OneDrive, Google Drive) et les services de messagerie (Gmail). Votre utilisation de ces intégrations est soumise aux conditions d\'utilisation respectives des services tiers. PulsarTeam n\'est pas responsable de la disponibilité, de l\'exactitude ou des politiques des services tiers.'
      },
      {
        heading: '8. Disponibilité du Service',
        text: 'Nous nous efforçons de maintenir une haute disponibilité du Service, mais ne garantissons pas un accès ininterrompu. Le Service peut être temporairement indisponible pour maintenance, mises à jour ou en raison de circonstances indépendantes de notre volonté. Pour les déploiements auto-hébergés, la disponibilité est la responsabilité de l\'organisation déployant le Service.'
      },
      {
        heading: '9. Limitation de responsabilité',
        text: 'Dans la mesure maximale permise par la loi applicable, PulsarTeam et ses contributeurs ne sauraient être tenus responsables de tout dommage indirect, accessoire, spécial, consécutif ou punitif résultant de votre utilisation du Service, y compris mais sans s\'y limiter les dommages résultant des actions des agents IA, des déploiements de code, de la perte de données ou des interruptions de service.'
      },
      {
        heading: '10. Modifications des conditions',
        text: 'Nous nous réservons le droit de modifier ces conditions à tout moment. Les modifications seront communiquées via l\'interface du Service ou par e-mail. La poursuite de l\'utilisation du Service après la publication des modifications constitue l\'acceptation des conditions modifiées.'
      },
      {
        heading: '11. Résiliation',
        text: 'Nous pouvons suspendre ou résilier votre accès au Service à tout moment en cas de violation de ces conditions. En cas de résiliation, votre droit d\'utiliser le Service cesse immédiatement. Vous pouvez exporter vos données avant la résiliation lorsque cela est techniquement possible.'
      },
      {
        heading: '12. Droit applicable',
        text: 'Les présentes conditions sont régies par et interprétées conformément au droit français. Tout litige découlant de ces conditions sera soumis à la compétence exclusive des tribunaux de Paris, France.'
      },
      {
        heading: '13. Contact',
        text: 'Pour toute question concernant ces conditions, veuillez nous contacter via le formulaire de contact sur le site web de PulsarTeam ou via le canal de support disponible dans l\'application.'
      }
    ]
  }
};

export default function TermsPage({ onBack }: { onBack?: () => void }) {
  const { lang } = useLanguage();
  const c = content[lang];

  const handleBack = () => {
    if (onBack) return onBack();
    window.history.length > 1 ? window.history.back() : (window.location.href = '/');
  };

  return (
    <div className="min-h-screen bg-dark-950 text-dark-200">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <button
          onClick={handleBack}
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
