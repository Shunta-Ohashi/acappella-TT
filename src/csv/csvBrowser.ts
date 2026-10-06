export const downloadTextFile = (
  content: string,
  filename: string,
  type: string,
): void => {
  const objectUrl = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  try {
    link.href = objectUrl
    link.download = filename
    document.body.appendChild(link)
    link.click()
  } finally {
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
  }
}

export const downloadCsv = (content: string, filename: string): void =>
  downloadTextFile(content, filename, 'text/csv;charset=utf-8')
