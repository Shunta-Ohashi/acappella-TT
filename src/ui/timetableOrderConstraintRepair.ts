import type { TimetableOrderConstraint } from '../domain/models.ts'
import { deleteTimetableOrderConstraint } from '../domain/timetableOrderConstraints.ts'

export type TimetableOrderConstraintRepairDeletionResult =
  | { kind: 'blocked' }
  | { kind: 'error'; errors: string[] }
  | { kind: 'committed' }

export const commitTimetableOrderConstraintRepairDeletion = ({
  readOnly,
  pendingDeletion,
  timetableOrderConstraints,
  onCommit,
}: {
  readOnly: boolean
  pendingDeletion: TimetableOrderConstraint | null
  timetableOrderConstraints: TimetableOrderConstraint[]
  onCommit: (constraints: TimetableOrderConstraint[]) => void
}): TimetableOrderConstraintRepairDeletionResult => {
  if (readOnly || !pendingDeletion) return { kind: 'blocked' }

  const result = deleteTimetableOrderConstraint({
    timetableOrderConstraints,
    constraintId: pendingDeletion.id,
  })
  if (!result.ok) return { kind: 'error', errors: result.errors }

  onCommit(result.timetableOrderConstraints)
  return { kind: 'committed' }
}
