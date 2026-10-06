export const downloadBinaryFile = (
  content: Uint8Array,
  filename: string,
  type: string,
): void => {
  const bytes = new Uint8Array(content)
  const objectUrl = URL.createObjectURL(new Blob([bytes.buffer], { type }))
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
