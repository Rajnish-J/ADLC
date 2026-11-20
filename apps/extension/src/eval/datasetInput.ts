// Phase 6 — pure parsing/validation for the Evaluate dataset wizard (W-1).
//
// The interactive wizard (QuickPick / InputBox / file picker) lives in
// evaluateAgent.ts; the parsing and validation it relies on lives here, free of
// `vscode`, so it is unit-testable in isolation (W-7). Both the "Paste JSON" and
// "Load from file" sources funnel through these helpers into the same row shape
// that datasetBuilder consumes.

export interface DatasetRow {
  query?: string
  response?: string
  ground_truth?: string
  [k: string]: unknown
}

export type ParseResult = { ok: true; rows: DatasetRow[] } | { ok: false; error: string }

/** The schema hint pre-filled into the Paste-JSON input box. */
export const PASTE_SCHEMA_PLACEHOLDER = '[{"query":"...","response":"...","ground_truth":"..."}]'

/** Validate a parsed value is a non-empty array of row objects, each with a string `query`. */
function validateRows(value: unknown): ParseResult {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'Expected a JSON array of row objects, e.g. [{"query":"..."}].' }
  }
  if (value.length === 0) {
    return { ok: false, error: 'Dataset is empty — provide at least one row.' }
  }
  for (let i = 0; i < value.length; i++) {
    const row = value[i]
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      return { ok: false, error: `Row ${i + 1} is not an object.` }
    }
    const q = (row as DatasetRow).query
    if (typeof q !== 'string' || q.trim() === '') {
      return { ok: false, error: `Row ${i + 1} is missing a non-empty "query" string.` }
    }
  }
  return { ok: true, rows: value as DatasetRow[] }
}

/** Parse + validate JSON pasted into the input box (must be an array of rows). */
export function parsePastedRows(text: string): ParseResult {
  const trimmed = text.trim()
  if (!trimmed) {
    return { ok: false, error: 'No content provided.' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  return validateRows(parsed)
}

/**
 * Parse a loaded dataset file. `.jsonl` is parsed line-by-line (one JSON object
 * per non-blank line); anything else is parsed as a single JSON document that
 * must be an array. Both paths validate to the same row shape.
 */
export function parseDatasetFile(content: string, ext: string): ParseResult {
  if (ext.toLowerCase() === '.jsonl') {
    const rows: DatasetRow[] = []
    const lines = content.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        rows.push(JSON.parse(line) as DatasetRow)
      } catch (err) {
        return {
          ok: false,
          error: `Line ${i + 1} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }
    return validateRows(rows)
  }

  // .json — a single document. Accept an array, or a lone object as a 1-row array.
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    parsed = [parsed]
  }
  return validateRows(parsed)
}

/** Derive a single-agent response map from rows (first row's response), if any. */
export function responsesFor(
  agentId: string,
  rows: DatasetRow[],
): Record<string, string> | undefined {
  const first = rows.find((r) => typeof r.response === 'string' && r.response !== '')
  return first ? { [agentId]: first.response as string } : undefined
}
