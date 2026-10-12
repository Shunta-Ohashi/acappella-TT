import type { Event } from '../domain/models'
import {
  hasEventBasicInfoDraftChanges,
  type EventBasicInfoDraft,
} from '../domain/eventBasicInfo'

export interface PendingEventDeletion {
  eventId: Event['id']
  label: string
  hasUnsavedDraft: boolean
}

export const createPendingEventDeletion = ({
  event,
  currentDraft,
  savedDraft,
}: {
  event: Pick<Event, 'id' | 'name'>
  currentDraft: EventBasicInfoDraft
  savedDraft: EventBasicInfoDraft
}): PendingEventDeletion => ({
  eventId: event.id,
  label: event.name,
  hasUnsavedDraft: hasEventBasicInfoDraftChanges(currentDraft, savedDraft),
})
