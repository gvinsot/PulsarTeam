import { useState } from 'react';
import { Search, Plus, X } from 'lucide-react';
import { api } from '../../api';
import type { RegistryPage, RegistryServer } from '../../types';
import { errorMessage } from '../../utils/errors';

export default function McpRegistryCatalog({
  agentId,
  boardId,
  onInstalled,
}: {
  agentId?: string;
  boardId?: string;
  onInstalled: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState<RegistryPage | null>(null);
  const [activeSearch, setActiveSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<RegistryServer | null>(null);
  const [endpoint, setEndpoint] = useState(0);
  const [mode, setMode] = useState<'oauth' | 'api_key'>('oauth');

  const load = async (more = false) => {
    setBusy(true);
    setError('');
    try {
      const query = more ? activeSearch : search;
      const next = await api.searchMcpRegistry(query, more ? page?.nextCursor || '' : '');
      setActiveSearch(query);
      setPage(prev =>
        more ? { ...next, servers: [...(prev?.servers || []), ...next.servers] } : next
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const install = async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const plugin = await api.installRegistryMcp(selected.name, selected.version, endpoint, mode);
      if (agentId) await api.assignPlugin(agentId, plugin.id);
      else if (boardId) await api.assignBoardPlugin(boardId, plugin.id);
      setSelected(null);
      setOpen(false);
      onInstalled();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        onClick={() => {
          setOpen(true);
          if (!page) void load();
        }}
        className="flex items-center gap-2 text-xs text-indigo-300 border border-indigo-500/40 rounded-lg px-3 py-2 hover:bg-indigo-500/10"
      >
        <Plus className="w-4 h-4" /> Parcourir le catalogue MCP
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4"
          onClick={e => e.stopPropagation()}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Catalogue MCP"
            className="bg-dark-900 border border-dark-700 rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
          >
            <div className="p-4 border-b border-dark-700 flex justify-between items-center">
              <h3 className="text-dark-100 font-semibold">Catalogue MCP</h3>
              <button aria-label="Fermer le catalogue" onClick={() => setOpen(false)}>
                <X className="w-5 h-5 text-dark-300" />
              </button>
            </div>
            <div className="p-4 overflow-auto space-y-3">
              <p className="text-xs text-dark-400">
                Registre officiel · MCP distants HTTP · OAuth ou clé API. Choisissez le mode indiqué
                par le fournisseur ; le référencement ne garantit pas sa compatibilité OAuth.
              </p>
              <form
                className="flex gap-2"
                onSubmit={e => {
                  e.preventDefault();
                  setSelected(null);
                  void load();
                }}
              >
                <input
                  aria-label="Rechercher un MCP"
                  className="flex-1 min-w-0 bg-dark-800 border border-dark-600 rounded px-3 py-2 text-sm text-dark-100"
                  placeholder="Rechercher un service…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
                <button
                  disabled={busy}
                  aria-label="Rechercher"
                  className="bg-indigo-600 p-2 rounded text-white disabled:opacity-50"
                >
                  <Search className="w-5 h-5" />
                </button>
              </form>
              {error && (
                <p role="alert" className="text-xs text-red-400">
                  {error}
                </p>
              )}
              {selected ? (
                <div className="space-y-3 p-3 border border-indigo-500/40 rounded-lg">
                  <h4 className="text-dark-100 font-medium">{selected.title}</h4>
                  <p className="text-xs text-dark-400">Version {selected.version}</p>
                  <label className="block text-xs text-dark-300">
                    Serveur
                    <select
                      className="block w-full bg-dark-800 border border-dark-600 rounded p-2 mt-1"
                      value={endpoint}
                      onChange={e => setEndpoint(Number(e.target.value))}
                    >
                      {selected.remotes.map((remote, i) => (
                        <option key={remote.url} value={i}>
                          {remote.url}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs text-dark-300">
                    Authentification
                    <select
                      className="block w-full bg-dark-800 border border-dark-600 rounded p-2 mt-1"
                      value={mode}
                      onChange={e => setMode(e.target.value as 'oauth' | 'api_key')}
                    >
                      <option value="oauth">OAuth — Connecter dans le navigateur</option>
                      <option value="api_key">Clé API — Configurer un accès</option>
                    </select>
                  </label>
                  {!!selected.remotes[endpoint]?.headerNames.length && (
                    <p className="text-xs text-dark-400">
                      En-têtes déclarés : {selected.remotes[endpoint].headerNames.join(', ')}
                    </p>
                  )}
                  <p className="text-xs text-dark-400">
                    Le plugin sera ajouté {agentId ? 'à cet agent' : 'à ce board'}. Vous pourrez
                    ensuite connecter votre compte ou saisir votre clé.
                  </p>
                  <div className="flex gap-3">
                    <button
                      disabled={busy}
                      onClick={install}
                      className="px-3 py-2 rounded bg-indigo-600 text-white text-xs disabled:opacity-50"
                    >
                      {busy ? 'Ajout…' : 'Ajouter le plugin'}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => setSelected(null)}
                      className="text-xs text-dark-300"
                    >
                      Retour
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {page?.servers.map(server => (
                    <button
                      key={`${server.name}:${server.version}`}
                      className="text-left w-full rounded-lg border border-dark-700 p-3 hover:border-indigo-500"
                      disabled={busy}
                      onClick={() => {
                        setSelected(server);
                        setEndpoint(0);
                        setMode('oauth');
                      }}
                    >
                      <span className="text-sm font-medium text-dark-100">{server.title}</span>
                      <span className="ml-2 text-xs text-dark-500">{server.version}</span>
                      <p className="text-[11px] text-dark-500 break-all">{server.name}</p>
                      <p className="text-xs text-dark-400 mt-1">{server.description}</p>
                    </button>
                  ))}
                  {busy && (
                    <p role="status" className="text-xs text-dark-400">
                      Chargement…
                    </p>
                  )}
                  {page && !page.servers.length && !busy && (
                    <p className="text-xs text-dark-400">
                      Aucun MCP distant compatible sur cette page.
                    </p>
                  )}
                  {page?.nextCursor && (
                    <button
                      disabled={busy}
                      onClick={() => load(true)}
                      className="text-xs text-indigo-400"
                    >
                      Charger la suite
                    </button>
                  )}
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
