import { useState, useEffect, useCallback } from 'react';
import { X, Wrench, Loader, Puzzle } from 'lucide-react';
import { api } from '../../api';
import { AssignedPluginCard, AvailablePluginRow, CategoryFilterPills } from '../plugins/pluginShared';

export default function BoardPluginsTab({ board, onClose }) {
  const [plugins, setPlugins] = useState([]);
  const [boardPlugins, setBoardPlugins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState('all');

  const loadData = useCallback(async () => {
    try {
      const [allPlugins, boardData] = await Promise.all([
        api.getPlugins(),
        api.getBoardPlugins(board.id),
      ]);
      setPlugins(allPlugins);
      setBoardPlugins(boardData.plugins || []);
    } catch (err) {
      console.error('Failed to load board plugins:', err);
    } finally {
      setLoading(false);
    }
  }, [board.id]);

  useEffect(() => { loadData(); }, [loadData]);

  const assignedPlugins = plugins.filter(p => boardPlugins.includes(p.id));
  const availablePlugins = plugins.filter(p => !boardPlugins.includes(p.id));
  const categories = ['all', ...new Set(plugins.map(s => s.category).filter(Boolean))];
  const filteredAvailable = categoryFilter === 'all'
    ? availablePlugins
    : availablePlugins.filter(s => s.category === categoryFilter);

  const handleAssign = async (pluginId) => {
    await api.assignBoardPlugin(board.id, pluginId);
    setBoardPlugins(prev => [...prev, pluginId]);
  };

  const handleRemove = async (pluginId) => {
    await api.removeBoardPlugin(board.id, pluginId);
    setBoardPlugins(prev => prev.filter(id => id !== pluginId));
  };

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="bg-dark-800 rounded-xl border border-dark-700 p-8">
          <Loader className="w-6 h-6 text-indigo-400 animate-spin mx-auto" />
          <p className="text-dark-400 text-sm mt-3">Loading board plugins...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-dark-800 rounded-xl border border-dark-700 shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-dark-700">
          <div className="flex items-center gap-2">
            <Puzzle className="w-5 h-5 text-indigo-400" />
            <h2 className="text-lg font-semibold text-dark-100">Board Plugins</h2>
            <span className="text-xs text-dark-500">{board.name}</span>
          </div>
          <button onClick={onClose} className="p-1 text-dark-400 hover:text-dark-200 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4 space-y-5">
          {/* Assigned plugins */}
          <div>
            <h3 className="font-medium text-dark-200 text-sm mb-3">
              Board Plugins
              <span className="ml-2 text-dark-400 font-normal">({assignedPlugins.length})</span>
            </h3>
            <p className="text-[11px] text-dark-500 mb-3">
              Plugins assigned here are available to all agents working on this board. Agent-level auth takes priority over board-level auth.
            </p>
            {assignedPlugins.length > 0 ? (
              <div className="space-y-2">
                {assignedPlugins.map(plugin => (
                  <AssignedPluginCard
                    key={plugin.id}
                    plugin={plugin}
                    connectorProps={{ boardId: board.id, onStatusChange: () => loadData() }}
                    onRemove={() => handleRemove(plugin.id)}
                  />
                ))}
              </div>
            ) : (
              <div className="text-center py-4 border border-dashed border-dark-700 rounded-lg">
                <Wrench className="w-5 h-5 mx-auto mb-1 text-dark-500 opacity-40" />
                <p className="text-dark-500 text-xs">No plugins assigned to this board</p>
              </div>
            )}
          </div>

          {/* Available plugins */}
          <div>
            <h3 className="font-medium text-dark-200 text-sm mb-3">
              Available Plugins
              <span className="ml-2 text-dark-400 font-normal">({filteredAvailable.length})</span>
            </h3>

            <CategoryFilterPills categories={categories} value={categoryFilter} onChange={setCategoryFilter} />

            <div className="space-y-2">
              {filteredAvailable.map(plugin => (
                <AvailablePluginRow
                  key={plugin.id}
                  plugin={plugin}
                  onAdd={() => handleAssign(plugin.id)}
                />
              ))}
              {filteredAvailable.length === 0 && (
                <p className="text-center text-dark-500 text-xs py-4">
                  {availablePlugins.length === 0 ? 'All plugins assigned' : 'No plugins in this category'}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
