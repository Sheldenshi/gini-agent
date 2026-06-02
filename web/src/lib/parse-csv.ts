// Dependency-free CSV/TSV parser for the file preview drawer. Handles
// double-quote-quoted fields (with `""` as an escaped quote), the configured
// delimiter inside and outside quotes, and CRLF/LF row breaks. Returns a grid
// of rows; a single trailing empty row is dropped only when the input ended
// with a line break (so an explicit empty final row is preserved).
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const endedWithBreak =
    text.length > 0 && (text[text.length - 1] === "\n" || text[text.length - 1] === "\r");

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          // Escaped quote inside a quoted field.
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i++;
      continue;
    }
    if (ch === "\r") {
      // Treat CRLF as a single row break; a bare CR also ends the row.
      endRow();
      i += text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Flush the final field/row (the loop ends without a trailing break).
  endRow();

  // Drop a single trailing empty row produced by a trailing newline.
  const last = rows[rows.length - 1];
  if (endedWithBreak && rows.length > 1 && last && last.length === 1 && last[0] === "") {
    rows.pop();
  }
  return rows;
}
