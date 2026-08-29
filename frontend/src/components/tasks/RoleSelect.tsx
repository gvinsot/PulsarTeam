import { AUTO_ROLE, buildRoleOptions } from './workflowRoles';

// Role dropdown shared by the workflow editor and the instructions modal.
// It always receives the *unfiltered* agent list plus the edited board id:
// roles backed by an agent on this board come first, roles that only exist on
// other boards stay reachable in a second group.

export default function RoleSelect({
  value,
  onChange,
  agents,
  boardId = null,
  className = '',
  allowAuto = true,
  emptyLabel = 'Role...',
}) {
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
        <optgroup label="Agents on other boards">
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
