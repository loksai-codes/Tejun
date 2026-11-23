// "Did you mean" suggestions by edit distance.

/** The closest candidate within a small edit distance, or undefined. */
export function closest(word: string, candidates: Iterable<string>): string | undefined {
  const limit = word.length <= 3 ? 1 : 2;
  let best: string | undefined;
  let bestDistance = limit + 1;
  for (const c of candidates) {
    const d = c.toLowerCase() === word.toLowerCase() ? 0.5 : editDistance(word, c);
    if (d > 0 && d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}

export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost));
    }
    prev = row;
  }
  return prev[b.length]!;
}
