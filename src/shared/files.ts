// Browser-only file helpers shared by the ERD workspaces.
export const FILE_LIMIT = 20 * 1024 * 1024

export function download(bytes: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
export const fileStem = (value: string) => Array.from(value).filter((character) => character.charCodeAt(0) >= 32).join('').replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, '_').replace(/^[._]+|[._]+$/g, '') || 'Module'
export const errorText = (error: unknown) => (error instanceof Error ? error.message : 'The operation could not be completed.')
