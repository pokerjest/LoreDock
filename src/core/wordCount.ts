export function countWords(text: string): number {
  const cjkMatches = text.match(/[\u3400-\u9fff]/g) ?? [];
  const latinMatches = text.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g) ?? [];
  return cjkMatches.length + latinMatches.length;
}

export function chapterTail(text: string, maxChars = 5000): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return trimmed.slice(-maxChars);
}
