import { useState } from 'react';
import {
  Cloud,
  ExternalLink,
  FilePlus2,
  FilePen,
  FileX2,
  FolderPlus,
  GitCommit,
} from 'lucide-react';
import { CommitsDiffPanel } from '../AllCommitsDiffModal';
import { groupStorageChanges } from './storageChanges';
import type { TaskCommit, TaskStorageChange } from '../../types';

/**
 * The task modal's "Modifications" tab: what the task changed. Two sources,
 * switched by a segmented control when both have entries:
 *  - the linked commits, browsed with the same diff view as the All Commits
 *    modal (CommitsDiffPanel — revert flow included);
 *  - the Google Drive / OneDrive items its runs wrote (task.storageChanges,
 *    recorded by api/src/services/taskStorageChanges.ts).
 */

type Source = 'commits' | 'storage';

const PROVIDER_LABEL: Record<TaskStorageChange['provider'], string> = {
  gdrive: 'Google Drive',
  onedrive: 'OneDrive',
};

const ACTION_META: Record<
  TaskStorageChange['action'],
  { label: string; icon: typeof FilePlus2; className: string }
> = {
  created: { label: 'Created', icon: FilePlus2, className: 'bg-green-500/15 text-green-400' },
  updated: { label: 'Modified', icon: FilePen, className: 'bg-yellow-500/15 text-yellow-400' },
  deleted: { label: 'Deleted', icon: FileX2, className: 'bg-red-500/15 text-red-400' },
  folder_created: {
    label: 'Folder created',
    icon: FolderPlus,
    className: 'bg-blue-500/15 text-blue-400',
  },
};

function StorageChangesList({ changes }: { changes: TaskStorageChange[] }) {
  return (
    <div className="space-y-4">
      {groupStorageChanges(changes).map(({ provider, items }) => (
        <div key={provider} className="border border-white/10 rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 bg-gray-800/60 text-sm text-white font-medium">
            <Cloud className="w-4 h-4 text-sky-400" />
            {PROVIDER_LABEL[provider] || provider}
            <span className="text-xs text-gray-400 font-normal">
              {items.length} item{items.length !== 1 ? 's' : ''}
            </span>
          </div>
          <ul>
            {items.map(change => {
              const meta = ACTION_META[change.action] || ACTION_META.updated;
              const Icon = meta.icon;
              const openable = change.webUrl && change.action !== 'deleted';
              return (
                <li
                  key={`${change.itemId || ''}|${change.path}`}
                  className="flex items-center gap-3 px-4 py-2 border-t border-white/5 text-sm"
                >
                  <span
                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0 ${meta.className}`}
                  >
                    <Icon className="w-3 h-3" />
                    {meta.label}
                  </span>
                  <span
                    className={`font-mono text-gray-200 truncate ${change.action === 'deleted' ? 'line-through opacity-70' : ''}`}
                    title={change.path}
                  >
                    {change.path}
                  </span>
                  {change.count > 1 && (
                    <span
                      className="text-[10px] text-gray-400 shrink-0"
                      title={`${change.count} writes`}
                    >
                      ×{change.count}
                    </span>
                  )}
                  <span className="ml-auto text-xs text-gray-500 shrink-0">
                    {change.at ? new Date(change.at).toLocaleString() : ''}
                  </span>
                  {openable ? (
                    <a
                      href={change.webUrl!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1 rounded text-gray-400 hover:text-white hover:bg-white/10 shrink-0"
                      title={`Open in ${PROVIDER_LABEL[provider] || provider}`}
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  ) : (
                    <span className="w-[22px] shrink-0" />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export default function TaskModifications({
  taskId,
  agentId,
  commits,
  storageChanges,
}: {
  taskId: string;
  agentId: string | null;
  commits: TaskCommit[];
  storageChanges: TaskStorageChange[];
}) {
  const [source, setSource] = useState<Source>(
    commits.length === 0 && storageChanges.length > 0 ? 'storage' : 'commits'
  );

  if (commits.length === 0 && storageChanges.length === 0) {
    return (
      <p className="text-sm text-dark-400 py-6 text-center">
        No modifications yet — commits linked to this task and Google Drive / OneDrive files its
        agents write will show up here.
      </p>
    );
  }

  const sources: { id: Source; label: string; count: number; icon: typeof Cloud }[] = [
    { id: 'commits', label: 'Commits', count: commits.length, icon: GitCommit },
    { id: 'storage', label: 'Drive files', count: storageChanges.length, icon: Cloud },
  ];

  return (
    <div className="space-y-3">
      <div role="radiogroup" className="inline-flex rounded-lg border border-dark-700 p-0.5">
        {sources.map(({ id, label, count, icon: Icon }) => (
          <button
            key={id}
            role="radio"
            aria-checked={source === id}
            onClick={() => setSource(id)}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              source === id ? 'bg-dark-700 text-dark-100' : 'text-dark-400 hover:text-dark-200'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
            <span className="text-[10px] text-dark-400">{count}</span>
          </button>
        ))}
      </div>

      {source === 'commits' &&
        (commits.length > 0 ? (
          <div className="border border-white/10 rounded-xl bg-gray-900 flex flex-col">
            <CommitsDiffPanel
              taskId={taskId}
              commits={commits}
              agentId={agentId}
              scrollClassName="p-3 space-y-3"
            />
          </div>
        ) : (
          <p className="text-sm text-dark-400 py-4">No commits linked to this task.</p>
        ))}

      {source === 'storage' &&
        (storageChanges.length > 0 ? (
          <StorageChangesList changes={storageChanges} />
        ) : (
          <p className="text-sm text-dark-400 py-4">
            No Google Drive / OneDrive file written by this task.
          </p>
        ))}
    </div>
  );
}
