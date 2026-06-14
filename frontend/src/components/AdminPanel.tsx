import { useState } from 'react';
import { X, Users, Crown, Settings, Cpu, LayoutGrid } from 'lucide-react';
import UsersTab from './admin/UsersTab';
import SettingsTab from './admin/SettingsTab';
import LlmConfigsTab from './admin/LlmConfigsTab';
import BoardsTab from './admin/BoardsTab';

const TABS = [
  { id: 'users', label: 'Users', icon: Users },
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'llm', label: 'LLM Models', icon: Cpu },
  { id: 'boards', label: 'Boards', icon: LayoutGrid },
];

export default function AdminPanel({ onClose, onImpersonate, showToast }) {
  const [activeTab, setActiveTab] = useState('users');

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
      <div
        className="bg-dark-900 border border-dark-700 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-dark-700">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-500 to-orange-600 flex items-center justify-center">
              <Crown className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-dark-100">Admin Settings</h2>
              <p className="text-xs text-dark-400">Administration & Configuration</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-dark-700">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-2 px-6 py-3 text-sm font-medium transition-colors border-b-2 ${
                activeTab === id
                  ? 'border-indigo-500 text-indigo-400'
                  : 'border-transparent text-dark-400 hover:text-dark-200'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </div>

        {/* Content — all tabs stay mounted so their in-progress form state
            survives a tab round-trip; visibility is toggled with CSS and the
            `active` prop drives each tab's activation re-fetches. */}
        <div className="flex-1 overflow-auto p-6">
          <div className={activeTab === 'users' ? 'space-y-6' : 'hidden'}>
            <UsersTab showToast={showToast} onImpersonate={onImpersonate} onClose={onClose} />
          </div>
          <div className={activeTab === 'settings' ? 'space-y-6' : 'hidden'}>
            <SettingsTab active={activeTab === 'settings'} showToast={showToast} />
          </div>
          <div className={activeTab === 'llm' ? 'space-y-6' : 'hidden'}>
            <LlmConfigsTab active={activeTab === 'llm'} showToast={showToast} />
          </div>
          <div className={activeTab === 'boards' ? 'space-y-6' : 'hidden'}>
            <BoardsTab active={activeTab === 'boards'} showToast={showToast} />
          </div>
        </div>
      </div>
    </div>
  );
}
