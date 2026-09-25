import type { DutyType } from '../domain/models'

export interface TimetableGridColumn {
  id: string
  label: string
  width: number
  dutyTypeId?: DutyType['id']
}

const fixedColumns: TimetableGridColumn[] = [
  { id: 'time', label: '時刻', width: 70 },
  { id: 'performance', label: '出演', width: 270 },
  { id: 'main-pa', label: 'Main PA', width: 90 },
  { id: 'sub-pa', label: 'Sub PA', width: 90 },
]

export const createTimetableGridColumns = (
  dutyTypes: DutyType[],
): TimetableGridColumn[] => [
  ...fixedColumns,
  ...[...dutyTypes]
    .sort((first, second) =>
      first.order - second.order || first.id.localeCompare(second.id),
    )
    .map((dutyType) => ({
      id: `duty-${dutyType.id}`,
      label: dutyType.name,
      width: 90,
      dutyTypeId: dutyType.id,
    })),
]
