// Ratcliff/Obershelp similarity, ported from Python's difflib.SequenceMatcher (isjunk=None) so FK resolution
// matches the reference parser exactly. Autojunk only applies to sequences of 200+ items, which names never reach.
export function similarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1
  const positions = new Map<string, number[]>()
  Array.from(b).forEach((character, index) => positions.set(character, [...(positions.get(character) ?? []), index]))
  if (b.length >= 200) {
    const limit = Math.floor(b.length / 100) + 1
    for (const [character, list] of positions) if (list.length > limit) positions.delete(character)
  }
  const longest = (aLow: number, aHigh: number, bLow: number, bHigh: number): [number, number, number] => {
    let bestI = aLow, bestJ = bLow, bestSize = 0
    let lengths = new Map<number, number>()
    for (let i = aLow; i < aHigh; i++) {
      const next = new Map<number, number>()
      for (const j of positions.get(a[i]) ?? []) {
        if (j < bLow) continue
        if (j >= bHigh) break
        const size = (lengths.get(j - 1) ?? 0) + 1
        next.set(j, size)
        if (size > bestSize) { bestI = i - size + 1; bestJ = j - size + 1; bestSize = size }
      }
      lengths = next
    }
    // difflib extends matches with equal neighbours that are not indexed (only junk, i.e. popular items here).
    while (bestI > aLow && bestJ > bLow && a[bestI - 1] === b[bestJ - 1] && !positions.has(b[bestJ - 1])) { bestI--; bestJ--; bestSize++ }
    while (bestI + bestSize < aHigh && bestJ + bestSize < bHigh && a[bestI + bestSize] === b[bestJ + bestSize] && !positions.has(b[bestJ + bestSize])) bestSize++
    return [bestI, bestJ, bestSize]
  }
  let matches = 0
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]]
  while (queue.length) {
    const [aLow, aHigh, bLow, bHigh] = queue.pop()!
    const [i, j, size] = longest(aLow, aHigh, bLow, bHigh)
    if (!size) continue
    matches += size
    if (aLow < i && bLow < j) queue.push([aLow, i, bLow, j])
    if (i + size < aHigh && j + size < bHigh) queue.push([i + size, aHigh, j + size, bHigh])
  }
  return 2 * matches / (a.length + b.length)
}

// Levenshtein edit distance, used by the validation report's typo check.
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    previous = current
  }
  return previous[b.length]
}
