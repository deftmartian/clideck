'use strict';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MIN_COLS = 20;
const MAX_COLS = 500;
const MIN_ROWS = 5;
const MAX_ROWS = 300;

function supplied(value) {
  return value !== undefined;
}

function normalizeTerminalSize(cols, rows) {
  const normalizedCols = supplied(cols) ? cols : DEFAULT_COLS;
  const normalizedRows = supplied(rows) ? rows : DEFAULT_ROWS;
  if (!Number.isSafeInteger(normalizedCols)
    || normalizedCols < MIN_COLS
    || normalizedCols > MAX_COLS
    || !Number.isSafeInteger(normalizedRows)
    || normalizedRows < MIN_ROWS
    || normalizedRows > MAX_ROWS) {
    return {
      ok: false,
      error: `Terminal size must be safe integers within ${MIN_COLS}-${MAX_COLS} columns and ${MIN_ROWS}-${MAX_ROWS} rows.`,
    };
  }
  return { ok: true, cols: normalizedCols, rows: normalizedRows };
}

function requireTerminalSize(cols, rows) {
  const size = normalizeTerminalSize(cols, rows);
  if (!size.ok) throw new RangeError(size.error);
  return { cols: size.cols, rows: size.rows };
}

module.exports = {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  normalizeTerminalSize,
  requireTerminalSize,
};
