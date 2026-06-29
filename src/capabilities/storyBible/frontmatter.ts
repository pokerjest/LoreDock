export interface FrontmatterDocument {
  hasFrontmatter: boolean;
  data: Record<string, unknown>;
  body: string;
  unknownChunks: string[];
  errors: string[];
}

interface FrontmatterChunk {
  key?: string;
  lines: string[];
}

export function parseMarkdownFrontmatter(text: string, knownKeys: Set<string>): FrontmatterDocument {
  const normalizedText = text.replace(/\r\n/g, "\n");
  const lines = normalizedText.split("\n");

  if (lines[0] !== "---") {
    return {
      hasFrontmatter: false,
      data: {},
      body: normalizedText,
      unknownChunks: [],
      errors: ["缺少 frontmatter。"]
    };
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex < 0) {
    return {
      hasFrontmatter: false,
      data: {},
      body: normalizedText,
      unknownChunks: [],
      errors: ["frontmatter 未闭合。"]
    };
  }

  const frontmatterLines = lines.slice(1, endIndex);
  const body = lines.slice(endIndex + 1).join("\n");
  const chunks = splitChunks(frontmatterLines);
  const data: Record<string, unknown> = {};
  const unknownChunks: string[] = [];
  const errors: string[] = [];

  for (const chunk of chunks) {
    if (!chunk.key || !knownKeys.has(chunk.key)) {
      unknownChunks.push(chunk.lines.join("\n"));
      continue;
    }

    const parsed = parseKnownChunk(chunk);
    if (parsed.ok) {
      data[chunk.key] = parsed.value;
    } else {
      errors.push(`${chunk.key}: ${parsed.error}`);
    }
  }

  return {
    hasFrontmatter: true,
    data,
    body,
    unknownChunks,
    errors
  };
}

export function stringifyMarkdownFrontmatter(
  fields: Record<string, unknown>,
  knownOrder: string[],
  body: string,
  existing?: Pick<FrontmatterDocument, "unknownChunks">
): string {
  const lines = ["---"];

  for (const key of knownOrder) {
    if (fields[key] !== undefined) {
      appendField(lines, key, fields[key]);
    }
  }

  for (const chunk of existing?.unknownChunks ?? []) {
    if (chunk.trim() !== "") {
      lines.push(...chunk.split("\n"));
    }
  }

  lines.push("---");
  return `${lines.join("\n")}\n${body.replace(/\r\n/g, "\n")}`;
}

export function markdownH1(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) {
      return match[1];
    }
  }

  return undefined;
}

function splitChunks(lines: string[]): FrontmatterChunk[] {
  const chunks: FrontmatterChunk[] = [];
  let current: FrontmatterChunk | undefined;

  for (const line of lines) {
    const key = topLevelKey(line);
    if (key) {
      current = { key, lines: [line] };
      chunks.push(current);
      continue;
    }

    if (!current) {
      current = { lines: [line] };
      chunks.push(current);
    } else {
      current.lines.push(line);
    }
  }

  return chunks;
}

function topLevelKey(line: string): string | undefined {
  if (/^\s/.test(line)) {
    return undefined;
  }

  return /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s|$)/.exec(line)?.[1];
}

function parseKnownChunk(chunk: FrontmatterChunk): { ok: true; value: unknown } | { ok: false; error: string } {
  const first = chunk.lines[0];
  const match = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(first);
  if (!match) {
    return { ok: false, error: "字段语法不合法。" };
  }

  const valueText = match[2].trim();
  const rest = chunk.lines.slice(1);

  if (valueText === "") {
    const values: string[] = [];
    for (const line of rest) {
      const listMatch = /^\s*-\s*(.*)$/.exec(line);
      if (!listMatch) {
        return { ok: false, error: "只支持字符串数组的 block list。" };
      }
      values.push(parseScalarString(listMatch[1].trim()));
    }
    return { ok: true, value: values };
  }

  if (valueText === "[]") {
    return { ok: true, value: [] };
  }

  if (valueText.startsWith("[") && valueText.endsWith("]")) {
    return { ok: true, value: parseInlineStringArray(valueText) };
  }

  if (rest.some((line) => line.trim() !== "")) {
    return { ok: false, error: "只支持单行字符串或字符串数组。" };
  }

  return { ok: true, value: parseScalarString(valueText) };
}

function parseScalarString(value: string): string {
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }

  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }

  return value;
}

function parseInlineStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item));
    }
  } catch {
    // Fall through to the permissive comma split below.
  }

  const inner = value.slice(1, -1).trim();
  if (inner === "") {
    return [];
  }

  return inner.split(",").map((item) => parseScalarString(item.trim()));
}

function appendField(lines: string[], key: string, value: unknown): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${key}: []`);
      return;
    }

    lines.push(`${key}:`);
    for (const item of value) {
      lines.push(`  - ${JSON.stringify(String(item))}`);
    }
    return;
  }

  lines.push(`${key}: ${JSON.stringify(String(value))}`);
}

