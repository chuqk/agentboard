import { memo } from 'react'
import type { Session } from '@shared/types'
import { getPathLeaf } from '../utils/sessionLabel'
import { formatRelativeTime } from '../utils/time'
import AgentIcon from './AgentIcon'
import ProjectBadge from './ProjectBadge'

interface OtherSessionItemProps {
  session: Session
  isSelected: boolean
  showProjectName: boolean
  onSelect: (sessionId: string) => void
}

/**
 * Read-only row for an "other" (undiscovered) tmux session surfaced on demand in
 * the "Other" section. Clicking it opens the session in the terminal; there is
 * deliberately no rename/kill/duplicate (these sessions live outside the normal
 * managed workflow).
 */
export default memo(function OtherSessionItem({
  session,
  isSelected,
  showProjectName,
  onSelect,
}: OtherSessionItemProps) {
  const directoryLeaf = getPathLeaf(session.projectPath)
  const displayName = session.name || directoryLeaf || session.id
  const showDirectory = showProjectName && Boolean(directoryLeaf)
  const lastActivity = formatRelativeTime(session.lastActivity)

  return (
    <div
      className={`session-row group cursor-pointer select-none px-3 py-2 ${isSelected ? 'selected' : ''}`}
      role="button"
      tabIndex={0}
      data-testid="other-session-card"
      data-session-id={session.id}
      title="Click to open (read-only)"
      onClick={() => onSelect(session.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(session.id)
        }
      }}
    >
      <div className="flex flex-col gap-0.5 pl-0.5">
        {/* Line 1: Icon + Name + Time */}
        <div className="flex items-center gap-2">
          <AgentIcon
            agentType={session.agentType}
            command={session.command}
            className="h-3.5 w-3.5 shrink-0 text-muted"
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
            {displayName}
          </span>
          <span className="ml-1 shrink-0 text-right text-xs tabular-nums text-muted">
            {lastActivity}
          </span>
        </div>

        {/* Line 2: Project badge */}
        {showDirectory && (
          <div className="flex flex-wrap items-center gap-1 pl-[1.375rem]">
            <ProjectBadge name={directoryLeaf!} fullPath={session.projectPath} />
          </div>
        )}
      </div>
    </div>
  )
})
