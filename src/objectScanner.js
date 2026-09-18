// News files are single-line JSON arrays of up to ~340 MB, so they can't be JSON.parse'd
// whole. ObjectScanner walks raw bytes, tracks string/brace state across chunk boundaries,
// and hands each complete top-level object to JSON.parse individually.
//
// Scanning bytes (not decoded text) is safe: the structural characters are ASCII and
// can never appear inside a multi-byte UTF-8 sequence.

const QUOTE = 0x22; // "
const BACKSLASH = 0x5c; // \
const OPEN = 0x7b; // {
const CLOSE = 0x7d; // }

export class ObjectScanner {
  constructor(onObject) {
    this.onObject = onObject;
    this.depth = 0;
    this.inString = false;
    this.escaped = false;
    this.parts = []; // pieces of an object that spans chunks
  }

  push(buf) {
    let start = this.depth > 0 ? 0 : -1;
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === BACKSLASH) this.escaped = true;
        else if (c === QUOTE) this.inString = false;
        continue;
      }
      if (c === QUOTE) {
        this.inString = true;
      } else if (c === OPEN) {
        if (this.depth === 0) start = i;
        this.depth++;
      } else if (c === CLOSE && this.depth > 0) {
        this.depth--;
        if (this.depth === 0) {
          const piece = buf.subarray(start, i + 1);
          let text;
          if (this.parts.length) {
            this.parts.push(piece);
            text = Buffer.concat(this.parts).toString('utf8');
            this.parts = [];
          } else {
            text = piece.toString('utf8');
          }
          start = -1;
          this.onObject(JSON.parse(text));
        }
      }
    }
    if (this.depth > 0) this.parts.push(buf.subarray(start));
  }

  /** True if the input ended in the middle of an object (truncated download). */
  get incomplete() {
    return this.depth > 0;
  }
}

// Every article object starts with the "date" key (vendor writer: Python json.dump).
// An unescaped quote can't occur inside a JSON string, so this byte sequence only ever
// matches a real object boundary — which lets us start parsing from the middle of a file.
const BOUNDARY = Buffer.from('}, {"date": ');

/**
 * Parse the complete article objects contained in the tail of a news file.
 * `reachedStart` means the chunk is the whole file (begins with the array's first object).
 */
export function parseTail(buf, { reachedStart = false } = {}) {
  let from;
  if (reachedStart) {
    from = 0;
  } else {
    const at = buf.indexOf(BOUNDARY);
    if (at === -1) return [];
    from = at + 3; // position of the '{'
  }
  const objects = [];
  const scanner = new ObjectScanner((o) => objects.push(o));
  scanner.push(buf.subarray(from));
  return objects;
}
