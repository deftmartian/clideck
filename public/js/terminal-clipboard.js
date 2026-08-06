export function trimTerminalSelection(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

export async function copyTrimmedTerminalSelection(text, writeText) {
  const source = String(text || '');
  const trimmed = trimTerminalSelection(source);
  if (!trimmed) return { copied: false, length: 0, saved: source.length };
  await writeText(trimmed);
  return { copied: true, length: trimmed.length, saved: source.length - trimmed.length };
}
