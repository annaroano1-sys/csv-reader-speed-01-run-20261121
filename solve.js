// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
// run(input) returns exactly what csv-reader 1.0.0's readCsv returns for the same input,
// {columns, rows, errors}, but read with one tight left-to-right scan: fields are taken as
// slices of the text (no per-character string building), and only the broken bits — a stray
// CR, a doubled quote, a line break inside quotes, junk after a closing quote, a quote that
// never closes — fall into the careful paths that the reference spells out.
//
// The reading policy, as the reference states it:
// - a U+FEFF at the very start is dropped;
// - a record ends at LF or CRLF, and a line left with no characters is no record;
// - outside quotes a CR not followed by LF is dropped (stray_cr);
// - a field that opens with a quote runs to the next quote that is not doubled, "" inside it
//   one quote and each CRLF or lone CR inside it read as LF; what follows its closing quote,
//   up to the next comma or line break, is appended as it stands (quote_junk, when the field
//   ends); a quote that never closes is a literal character, and the text after it is read
//   again as unquoted (unterminated_quote);
// - a quote inside an unquoted field is a literal character;
// - columns is the first record when header is true, else null; rows holds the records after
//   it (every record when header is false), each padded with "" (short_row, with fields: its
//   field count) or cut (long_row, with extra: the cut fields) to the first record's width;
// - each error is {code, line, row}, in the order met: line the 1-based line its record
//   starts on, row its record's index in rows (null for the header).
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes.
  let recordLine = 1;
  let recordRow = null;
  // How the last field ended: 0 comma (the record goes on), 1 line break, 2 end of text.
  let ended = 0;
  // Characters kept by the last unquoted read (for the quote_junk check).
  let unqAdded = 0;

  // Reads an unquoted field starting at `start`, with `acc` as the characters already kept
  // (null: none yet; '"' for a quote that never closed; the quoted value for quote junk).
  // Returns the field; sets ended and advances pos/line.
  function unq(acc, start) {
    let a = acc;
    unqAdded = 0;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        // ','
        unqAdded += pos - start;
        const v = a === null ? text.slice(start, pos) : a + text.slice(start, pos);
        pos += 1;
        ended = 0;
        return v;
      }
      if (c === 10) {
        // '\n'
        unqAdded += pos - start;
        const v = a === null ? text.slice(start, pos) : a + text.slice(start, pos);
        pos += 1;
        line += 1;
        ended = 1;
        return v;
      }
      if (c === 13) {
        // '\r'
        if (pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
          unqAdded += pos - start;
          const v = a === null ? text.slice(start, pos) : a + text.slice(start, pos);
          pos += 2;
          line += 1;
          ended = 1;
          return v;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        unqAdded += pos - start;
        a = (a === null ? '' : a) + text.slice(start, pos);
        pos += 1; // the CR is dropped; the field goes on
        start = pos;
        continue;
      }
      pos += 1;
    }
    unqAdded += pos - start;
    ended = 2;
    return a === null ? text.slice(start, pos) : a + text.slice(start, pos);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        // '"' — a quoted field.
        quoted = true;
        const open = pos;
        const openLine = line;
        let value = '';
        let start = pos + 1;
        pos += 1;
        let closed = false;
        while (pos < n) {
          const c = text.charCodeAt(pos);
          if (c === 34) {
            if (pos + 1 < n && text.charCodeAt(pos + 1) === 34) {
              value += text.slice(start, pos) + '"';
              pos += 2;
              start = pos;
              continue;
            }
            value += text.slice(start, pos);
            pos += 1;
            closed = true;
            break;
          }
          if (c === 13 || c === 10) {
            // CRLF and a lone CR inside quotes are each one LF.
            value += text.slice(start, pos) + '\n';
            if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) pos += 2;
            else pos += 1;
            line += 1;
            start = pos;
            continue;
          }
          pos += 1;
        }
        if (!closed) {
          // The quote never closes: it is a literal character, and the text after it is
          // read again as unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          fields.push(unq('"', pos));
        } else if (pos >= n) {
          fields.push(value);
          ended = 2;
        } else {
          const c = text.charCodeAt(pos);
          if (c === 44) {
            fields.push(value);
            pos += 1;
            ended = 0;
          } else if (c === 10) {
            fields.push(value);
            pos += 1;
            line += 1;
            ended = 1;
          } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
            fields.push(value);
            pos += 2;
            line += 1;
            ended = 1;
          } else {
            // What follows the closing quote is appended as it stands, up to the next
            // comma or line break.
            const v = unq(value, pos);
            if (unqAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            fields.push(v);
          }
        }
      } else {
        quoted = false;
        fields.push(unq(null, pos));
      }
    } while (ended === 0);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr
    // errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
