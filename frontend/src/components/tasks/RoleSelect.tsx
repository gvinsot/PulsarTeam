import { AUTO_ROLE, buildRoleOptions, type RoleAgent } from './workflowRoles';

// Role dropdown shared by the workflow editor and the instructions modal.
// It always receives the *unfiltered* agent list plus the edited board id:
// roles backed by an agent on this board come first, roles that only exist on
// other boards stay visible in a second group — but tasks are never handed to
// another board's agent, so such a role only runs once this board staffs it.

interface RoleSelectProps {
  /** Stored role, AUTO_ROLE, or absent when the action/condition has none. */
  value?: string;
  onChange: (role: string) => void;
  agents?: RoleAgent[];
  /** The edited board, or null before a board is selected — a board id is a
   *  UUID string or null (boards.id, api/src/services/database/baseSchema.ts). */
  boardId?: string | null;
  className?: string;
  allowAuto?: boolean;
  emptyLabel?: string;
}

export default function RoleSelect({
  value,
  onChange,
  agents,
  boardId = null,
  className = '',
  allowAuto = true,
  emptyLabel = 'Role...',
}: RoleSelectProps) {
  const { boardRoles, otherRoles } = buildRoleOptions(agents, boardId, value);

  return (
    <select
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      className={className}
      title={
        value === AUTO_ROLE
          ? 'The Role Router LLM (Admin Settings) picks the best role for each task'
          : undefined
      }
    >
      <option value="">{emptyLabel}</option>
      {allowAuto && <option value={AUTO_ROLE}>🤖 Automatic (AI picks role)</option>}
      {boardRoles.map(r => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
      {otherRoles.length > 0 && (
        <optgroup label="No agent on this board (won't run until one is added)">
          {otherRoles.map(r => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
