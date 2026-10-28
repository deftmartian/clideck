'use strict';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MIN_COLS = 20;
const MAX_COLS = 500;
const MIN_ROWS = 5;
const MAX_ROWS = 300;
const TERMINAL_PADDING_PX = 8;
const TERMINAL_CELL_WIDTH_PX = 7.8;
const TERMINAL_CELL_HEIGHT_PX = 17;

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

function estimateTerminalSize(width, height, { touchUi = false } = {}) {
  const availableWidth = Math.max(0, Number(width) - TERMINAL_PADDING_PX);
  const availableHeight = Math.max(0, Number(height) - TERMINAL_PADDING_PX);
  const minCols = touchUi ? MIN_COLS : DEFAULT_COLS;
  const minRows = touchUi ? MIN_ROWS : DEFAULT_ROWS;
  return {
    cols: Math.min(MAX_COLS, Math.max(Math.floor(availableWidth / TERMINAL_CELL_WIDTH_PX), minCols)),
    rows: Math.min(MAX_ROWS, Math.max(Math.floor(availableHeight / TERMINAL_CELL_HEIGHT_PX), minRows)),
  };
}

module.exports = {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  estimateTerminalSize,
  normalizeTerminalSize,
  requireTerminalSize,
};
