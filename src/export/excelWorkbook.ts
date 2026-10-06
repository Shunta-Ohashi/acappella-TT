import type { TimetableWorkbookModel } from './timetableWorkbook.ts'

export const TIMETABLE_WORKBOOK_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const getColumnWidth = (header: string): number => {
  if (header === 'スタート時間') return 12
  if (header === '内容') return 26
  return 16
}

export const createTimetableWorkbookXlsx = async (
  model: TimetableWorkbookModel,
): Promise<Uint8Array> => {
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Acappella TT'
  workbook.created = new Date()

  for (const sheetModel of model.sheets) {
    const worksheet = workbook.addWorksheet(sheetModel.name, {
      views: [{ state: 'frozen', ySplit: 1 }],
    })
    worksheet.addRow(sheetModel.headers)
    sheetModel.rows.forEach((row) => worksheet.addRow(row))
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: sheetModel.headers.length },
    }
    worksheet.columns = sheetModel.headers.map((header) => ({
      key: header,
      width: getColumnWidth(header),
    }))
    const headerRow = worksheet.getRow(1)
    headerRow.font = { bold: true }
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' }
    worksheet.eachRow((row) => {
      row.alignment = { vertical: 'middle' }
    })
  }

  const buffer = await workbook.xlsx.writeBuffer()
  return new Uint8Array(buffer)
}
