import { lastSegment } from './paths'

export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

export const firstLine = (text: string) => text.trim().split(/\r?\n/)[0] ?? ''

export const ago = (then: number, now: number) => {
  const minutes = Math.floor((now - then) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export const clip = (text: string, width: number) =>
  text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`

export const charCount = (text: string) => [...text].length

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export const defaultTitle = (branch: string | null, path: string) => {
  const tail = lastSegment(branch ?? path)
  const words = tail.replace(/[-_]+/g, ' ').trim()
  return words === '' ? tail : words.charAt(0).toUpperCase() + words.slice(1)
}

export const slugOf = (title: string) =>
  title.toLowerCase().replace(/[^a-z0-9._]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
