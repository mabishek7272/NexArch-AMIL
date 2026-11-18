/** Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, embedded newlines). Returns records keyed by the header row. */
export function parseCsv(text: string): { columns: string[]; rows: Array<Record<string, string>> } {
  const rows: string[][] = []; let row: string[] = []; let f = ''; let q = false; const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; } else f += c;
  }
  if (f.length || row.length) { row.push(f.replace(/\r$/, '')); rows.push(row); }
  const columns = rows.shift() ?? []; return { columns, rows: rows.filter((r) => r.length > 1 || r[0] !== '').map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? '']))) };
}
