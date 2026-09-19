// The `squares` input scheme of the encoder: a FEN as 69 fixed token ids. TypeScript twin of
// `rukh/src/rukh/models/squares.py` — the ids have to be the *same* ids, so the layout, the
// vocabulary order and every edge case are mirrored rather than re-invented:
//
//   0        <cls>            pooling anchor
//   1..64    the 64 squares   piece or <empty>, file-major (a1, a2, ..., a8, b1, ..., h8)
//   65       side to move     turn:w / turn:b
//   66       castling rights  one token with the 16 KQkq combinations
//   67       en passant       ep:none or the file (ep:a ... ep:h)
//   68       halfmove clock   clock:0 ... clock:3, the bucketed 50-move counter
//
// `fixtures/squares.json` is generated from the Python module itself and `tests/squares.test.ts`
// replays every case: if this file and Python ever disagree, the encoder would be fed a position
// it was not trained on and the evaluation bar would be quietly wrong.

/** The pieces, in the order the Python vocabulary lists them. */
export const PIECES = 'PNBRQKpnbrqk';

/** Castling rights in the order a FEN field is normalised to. */
export const CASTLING_ORDER = 'KQkq';

export const FILES = 'abcdefgh';

const N_SQUARES = 64;

/** Length of every `squares` sequence: 1 + 64 + 4. No padding is ever needed. */
export const SQUARE_TOKENS = 69;

/** Upper edges (exclusive) of the halfmove-clock buckets. */
export const CLOCK_EDGES = [6, 25, 50] as const;

/** The 16 castling combinations in a fixed order: `-`, `K`, `Q`, `KQ`, `k`, ... */
export function castlingStrings(): string[] {
  const out: string[] = [];
  for (let mask = 0; mask < 16; mask += 1) {
    let rights = '';
    for (let bit = 0; bit < CASTLING_ORDER.length; bit += 1) {
      if ((mask >> bit) & 1) rights += CASTLING_ORDER[bit];
    }
    out.push(rights || '-');
  }
  return out;
}

/** The token list in id order; see the module header for the layout it serves. */
export function buildSquareVocab(): string[] {
  return [
    '<pad>',
    '<mask>',
    '<cls>',
    '<empty>',
    ...PIECES,
    'turn:w',
    'turn:b',
    ...castlingStrings().map((rights) => `castle:${rights}`),
    'ep:none',
    ...FILES.split('').map((file) => `ep:${file}`),
    ...Array.from({ length: CLOCK_EDGES.length + 1 }, (_, index) => `clock:${index}`),
  ];
}

export const SQUARE_VOCAB: string[] = buildSquareVocab();

export const SQUARE_IDS: ReadonlyMap<string, number> = new Map(
  SQUARE_VOCAB.map((token, index) => [token, index]),
);

export const SQUARE_VOCAB_SIZE = SQUARE_VOCAB.length;

function idOf(token: string): number {
  const id = SQUARE_IDS.get(token);
  if (id === undefined) throw new Error(`unknown square token ${token}`);
  return id;
}

export const PAD_ID = idOf('<pad>');
export const MASK_ID = idOf('<mask>');
export const CLS_ID = idOf('<cls>');
export const EMPTY_ID = idOf('<empty>');

/** Index of the halfmove-clock bucket of `halfmove` (see `CLOCK_EDGES`). */
export function clockBucket(halfmove: number): number {
  if (!Number.isInteger(halfmove) || halfmove < 0) {
    throw new Error(`the halfmove clock cannot be negative, got ${halfmove}`);
  }
  return CLOCK_EDGES.reduce((count, edge) => count + (halfmove >= edge ? 1 : 0), 0);
}

/** The 64 square ids, file-major, from the piece-placement field of a FEN. */
function placementIds(placement: string): number[] {
  const ranks = placement.split('/');
  if (ranks.length !== 8) {
    throw new Error(`a FEN placement needs 8 ranks, got ${ranks.length}: ${placement}`);
  }
  const ids = new Array<number>(N_SQUARES).fill(EMPTY_ID);
  for (let row = 0; row < 8; row += 1) {
    const rank = 7 - row; // the placement is written from rank 8 down to rank 1
    let file = 0;
    for (const char of ranks[row]) {
      // Divergence from Python, on malformed input only: `str.isdigit()` there also says yes to
      // '0' and to non-ASCII digits ('٣', '²'), where this says no and reports an unknown piece.
      // Python then raises too ('0' leaves the rank short, `int('²')` throws), so no FEN is
      // accepted on one side and refused on the other — only the message differs.
      if (char >= '1' && char <= '9') {
        file += Number(char);
      } else if (PIECES.includes(char)) {
        if (file >= 8) throw new Error(`rank ${rank + 1} of ${placement} is too long`);
        ids[file * 8 + rank] = idOf(char);
        file += 1;
      } else {
        throw new Error(`unknown piece ${char} in ${placement}`);
      }
    }
    if (file !== 8) {
      throw new Error(`rank ${rank + 1} of ${placement} covers ${file} files, not 8`);
    }
  }
  return ids;
}

/** Token id of a FEN castling field, normalised to the `KQkq` order. */
function castlingId(field: string): number {
  if (field === '-' || field === '') return idOf('castle:-');
  for (const char of field) {
    if (!CASTLING_ORDER.includes(char)) {
      throw new Error(`unsupported castling field ${field} (Chess960 is out of scope)`);
    }
  }
  const rights = [...CASTLING_ORDER].filter((right) => field.includes(right)).join('');
  return idOf(`castle:${rights}`);
}

/**
 * The `SQUARE_TOKENS` ids of a FEN; four fields (`fen4`) or the full six are accepted.
 *
 * Throws on a malformed FEN: the encoder must never be fed a position that was silently
 * repaired into a different one.
 */
export function fenToTokens(fen: string): number[] {
  const fields = fen.trim().split(/\s+/).filter(Boolean);
  if (fields.length < 4) {
    throw new Error(`a FEN needs at least 4 fields, got ${fields.length}: ${fen}`);
  }
  const [placement, turn, castling, ep] = fields;
  if (turn !== 'w' && turn !== 'b') {
    throw new Error(`the side to move must be 'w' or 'b', got ${turn}`);
  }
  // Second divergence from Python, again only where no real FEN goes. `Number()` is not `int()`:
  // the `Number.isInteger` guard below keeps them in step on '1.5' (refused on both sides), but
  // '1e2' and '0x10' are read here as 100 and 16 while `int()` raises on them. A FEN whose
  // halfmove clock is written like that is malformed either way; it buckets instead of throwing.
  const halfmove = fields.length > 4 ? Number(fields[4]) : 0;
  if (!Number.isInteger(halfmove)) {
    throw new Error(`the halfmove clock must be an integer, got ${fields[4]}`);
  }
  let epToken: string;
  if (ep === '-' || ep === '') {
    epToken = 'ep:none';
  } else if (ep.length === 2 && FILES.includes(ep[0]) && (ep[1] === '3' || ep[1] === '6')) {
    epToken = `ep:${ep[0]}`;
  } else {
    throw new Error(`unknown en-passant square ${ep}`);
  }
  return [
    CLS_ID,
    ...placementIds(placement),
    idOf(`turn:${turn}`),
    castlingId(castling),
    idOf(epToken),
    idOf(`clock:${clockBucket(halfmove)}`),
  ];
}

/** The token strings of a sequence, for debugging. */
export function tokensToStrings(tokens: readonly number[]): string[] {
  return tokens.map((token) => SQUARE_VOCAB[token]);
}
