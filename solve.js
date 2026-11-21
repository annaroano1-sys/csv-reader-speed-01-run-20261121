// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader), round 2.
// run(input) returns exactly what csv-reader 1.0.0's readCsv returns for the same input,
// {columns, rows, errors}. Round 1's logic, but with the unquoted-field scan inlined into
// the single flat run() function: no nested helper, so pos/line/ended stay plain locals
// that V8 keeps in registers instead of a captured context object.
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

  let recordLine = 1;
  let recordRow = null;
  let ended = 0;

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
        // A quoted field.
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
          // Inlined unquoted scan with the '"' already kept.
          let a = '"';
          let s2 = pos;
          let endKind = -1;
          for (;;) {
            if (pos >= n) { endKind = 2; break; }
            const c = text.charCodeAt(pos);
            if (c === 44) { endKind = 0; break; }
            if (c === 10) { endKind = 1; break; }
            if (c === 13) {
              if (pos + 1 < n && text.charCodeAt(pos + 1) === 10) { endKind = 1; break; }
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
              a = a + text.slice(s2, pos);
              pos += 1;
              s2 = pos;
              continue;
            }
            pos += 1;
          }
          fields.push(a + text.slice(s2, pos));
          if (endKind === 0) { pos += 1; ended = 0; }
          else if (endKind === 1) {
            if (text.charCodeAt(pos) === 13) pos += 2; else pos += 1;
            line += 1;
            ended = 1;
          } else {
            ended = 2;
          }
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
            // comma or line break. Inlined unquoted scan with the quoted value kept.
            let a = value;
            let s2 = pos;
            let junkAdded = 0;
            let endKind = -1;
            for (;;) {
              if (pos >= n) { endKind = 2; break; }
              const c2 = text.charCodeAt(pos);
              if (c2 === 44) { endKind = 0; break; }
              if (c2 === 10) { endKind = 1; break; }
              if (c2 === 13) {
                if (pos + 1 < n && text.charCodeAt(pos + 1) === 10) { endKind = 1; break; }
                errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
                junkAdded += pos - s2;
                a = a + text.slice(s2, pos);
                pos += 1;
                s2 = pos;
                continue;
              }
              pos += 1;
            }
            junkAdded += pos - s2;
            fields.push(a + text.slice(s2, pos));
            if (junkAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            if (endKind === 0) { pos += 1; ended = 0; }
            else if (endKind === 1) {
              if (text.charCodeAt(pos) === 13) pos += 2; else pos += 1;
              line += 1;
              ended = 1;
            } else {
              ended = 2;
            }
          }
        }
      } else {
        // An unquoted field. Inlined scan to the next comma or line break.
        quoted = false;
        let a = null;
        let s2 = pos;
        let endKind = -1;
        for (;;) {
          if (pos >= n) { endKind = 2; break; }
          const c = text.charCodeAt(pos);
          if (c === 44) { endKind = 0; break; }
          if (c === 10) { endKind = 1; break; }
          if (c === 13) {
            if (pos + 1 < n && text.charCodeAt(pos + 1) === 10) { endKind = 1; break; }
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            a = (a === null ? '' : a) + text.slice(s2, pos);
            pos += 1;
            s2 = pos;
            continue;
          }
          pos += 1;
        }
        fields.push(a === null ? text.slice(s2, pos) : a + text.slice(s2, pos));
        if (endKind === 0) { pos += 1; ended = 0; }
        else if (endKind === 1) {
          if (text.charCodeAt(pos) === 13) pos += 2; else pos += 1;
          line += 1;
          ended = 1;
        } else {
          ended = 2;
        }
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
