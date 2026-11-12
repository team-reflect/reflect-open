export function pasteFiles(target: Element, files: File[]): void {
  const clipboardData = new DataTransfer()
  for (const file of files) {
    clipboardData.items.add(file)
  }
  const event = new ClipboardEvent('paste', {
    clipboardData,
    bubbles: true,
    cancelable: true,
  })
  target.dispatchEvent(event)
}
