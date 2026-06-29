export interface WordCountResult {
  count: number;
  isEmpty: boolean;
}

export function countMarkdownWords(markdown: string): WordCountResult {
  const text = stripMarkdownSyntax(markdown);
  const cjkMatches = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? [];
  const latinMatches = text.match(/[A-Za-z0-9_]+/g) ?? [];
  const count = cjkMatches.length + latinMatches.length;

  return {
    count,
    isEmpty: count === 0
  };
}

function stripMarkdownSyntax(markdown: string): string {
  let text = markdown.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/`[^`]*`/g, " ");
  text = text.replace(/!\[[^\]]*\]\([^)]+\)/g, " ");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^[\s>-]*[-*+]\s+/gm, "");
  text = text.replace(/^[\s>-]*\d+[.)]\s+/gm, "");
  text = text.replace(/[*_~>#|:[\]()`{}\\-]/g, " ");
  return text;
}
