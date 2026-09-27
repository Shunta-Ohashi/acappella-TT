import type { BreakScheduleItem, Section } from '../domain/models'
import type { TimetableGridColumn } from './timetableGridColumns'

export const getInterSectionBreakPresentation = (
  previousSection: Pick<Section, 'name'>,
  nextSection: Pick<Section, 'name'>,
  columns: readonly TimetableGridColumn[],
  item?: BreakScheduleItem,
) => ({
  sectionLabel: `${previousSection.name} → ${nextSection.name}`,
  // The time rowheader remains separate; every other column shares one cell.
  contentColumnSpan: columns.length - 1,
  title: item?.title,
  durationLabel: item ? `${item.durationMinutes}分` : '休憩未設定',
  removeAccessibleName: item
    ? `${previousSection.name}と${nextSection.name}の間の休憩「${item.title}」（${item.durationMinutes}分）を削除`
    : undefined,
})
