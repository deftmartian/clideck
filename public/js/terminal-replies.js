// The server's headless terminal owns query replies. Browser render/replay must
// never send a second reply to a program that has already finished its query.
export function isTerminalReply(data) {
  if (typeof data !== 'string') return false;
  return /^(?:\x1b\[|\x9b)(?:[?>=][\d;]*c|\??[\d;]+R|[03]n|\??[\d;]+\$y)$/.test(data)
    || /^(?:\x1bP|\x90)(?:>\|[\s\S]*|[01]\$r[\s\S]*|[01]\+r[\s\S]*)(?:\x1b\\|\x9c)$/.test(data)
    || /^(?:\x1b\]|\x9d)(?:10|11|12);rgb:[\da-f/]+(?:\x07|\x1b\\|\x9c)$/i.test(data);
}
