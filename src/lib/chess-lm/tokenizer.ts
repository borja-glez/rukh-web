// Fixed-vocabulary UCI tokenizer. The vocabulary is a deterministic enumeration (it does not
// depend on any data) implemented identically in Python (`rukh/src/rukh/tokenize/uci_vocab.py`)
// and here; `tests/parity.test.ts` checks both against the fixture exported from Python.

const FILES = 'abcdefgh';
const RANKS = '12345678';

/** The 64 squares in file-major order: a1, a2, ..., a8, b1, ..., h8 (index `file * 8 + rank`). */
export const SQUARES: readonly string[] = Array.from({ length: 64 }, (_, i) => {
  const file = FILES[Math.floor(i / 8)];
  const rank = RANKS[i % 8];
  return `${file}${rank}`;
});

/** Special tokens, in id order (0-7). Elo bins follow (8-61) and moves start at id 62. */
export const SPECIALS: readonly string[] = [
  '<pad>',
  '<bos>',
  '<eos>',
  '<mask>',
  '<unk>',
  '<1-0>',
  '<0-1>',
  '<1/2>',
];

export const PAD_ID = 0;
export const BOS_ID = 1;
export const EOS_ID = 2;
export const MASK_ID = 3;
export const UNK_ID = 4;

export const ELO_MIN = 600;
/** Upper clamp before binning, so 3200+ lands in `<w3200>`; it is not the highest bin (3200). */
export const ELO_CLAMP_MAX = 3299;
export const ELO_BIN_WIDTH = 100;
/** Number of Elo bins per side: 600, 700, ..., 3200. */
export const ELO_BIN_COUNT = 27;

const PROMOTION_PIECES = ['q', 'r', 'b', 'n'] as const;

/** Result strings accepted by `encodeGame`, mapped to their special token. */
const RESULT_TOKENS: Record<string, string> = {
  '1-0': '<1-0>',
  '0-1': '<0-1>',
  '1/2-1/2': '<1/2>',
};

function coords(square: string): [number, number] {
  return [FILES.indexOf(square[0] ?? ''), RANKS.indexOf(square[1] ?? '')];
}

/** True if `to` is reachable from `from` by a queen (same file, rank or diagonal) or a knight. */
function reachable(from: string, to: string): boolean {
  if (from === to) return false;
  const [ff, fr] = coords(from);
  const [tf, tr] = coords(to);
  const df = Math.abs(tf - ff);
  const dr = Math.abs(tr - fr);
  const queen = df === 0 || dr === 0 || df === dr;
  const knight = (df === 1 && dr === 2) || (df === 2 && dr === 1);
  return queen || knight;
}

/** Maps an Elo to its bin token: `clamp(elo, 600, 3299)` floored to hundreds, four digits. */
export function eloBin(elo: number, side: 'w' | 'b'): string {
  const clamped = Math.min(Math.max(elo, ELO_MIN), ELO_CLAMP_MAX);
  const bin = Math.floor(clamped / ELO_BIN_WIDTH) * ELO_BIN_WIDTH;
  return `<${side}${String(bin).padStart(4, '0')}>`;
}

function eloBinTokens(side: 'w' | 'b'): string[] {
  return Array.from({ length: ELO_BIN_COUNT }, (_, i) => eloBin(ELO_MIN + i * ELO_BIN_WIDTH, side));
}

/** Enumerates the 1968 pseudo-legal UCI move strings: 1792 plain moves then 176 promotions. */
export function buildMoves(): string[] {
  const moves: string[] = [];
  for (const from of SQUARES) {
    for (const to of SQUARES) {
      if (reachable(from, to)) moves.push(`${from}${to}`);
    }
  }
  for (const [fromRank, toRank] of [
    ['7', '8'],
    ['2', '1'],
  ]) {
    for (const from of SQUARES) {
      if (from[1] !== fromRank) continue;
      for (const to of SQUARES) {
        if (to[1] !== toRank) continue;
        if (Math.abs(coords(to)[0] - coords(from)[0]) > 1) continue;
        for (const piece of PROMOTION_PIECES) moves.push(`${from}${to}${piece}`);
      }
    }
  }
  return moves;
}

/** The full 2030-token vocabulary: specials, white Elo bins, black Elo bins, moves. */
export function buildVocab(): string[] {
  return [...SPECIALS, ...eloBinTokens('w'), ...eloBinTokens('b'), ...buildMoves()];
}

export class UciTokenizer {
  readonly tokens: readonly string[];
  private readonly ids: Map<string, number>;

  constructor(tokens: readonly string[] = buildVocab()) {
    this.tokens = tokens;
    this.ids = new Map(tokens.map((token, id) => [token, id]));
  }

  get size(): number {
    return this.tokens.length;
  }

  /** Id of a token, or `<unk>` (4) if it is not in the vocabulary. */
  tokenId(token: string): number {
    return this.ids.get(token) ?? UNK_ID;
  }

  /** Encodes a whitespace-separated UCI move string; unknown moves map to `<unk>`. */
  encodeMoves(uci: string): number[] {
    return uci
      .trim()
      .split(/\s+/)
      .filter((move) => move.length > 0)
      .map((move) => this.tokenId(move));
  }

  /**
   * `[<bos>, <wXXXX>, <bXXXX>, ...moves, <result>, <eos>]`. When the whole game fits in `maxLen`
   * the sequence ends with `<eos>`; otherwise it is cut to the first `maxLen` ids (no result, no
   * `<eos>`), exactly as `UciTokenizer.encode_game` does in Python.
   */
  encodeGame(
    uci: string,
    whiteElo: number,
    blackElo: number,
    result: string,
    maxLen = 200,
  ): number[] {
    const resultToken = RESULT_TOKENS[result.trim()];
    if (resultToken === undefined) throw new Error(`unknown result: ${result}`);
    const ids = [
      BOS_ID,
      this.tokenId(eloBin(whiteElo, 'w')),
      this.tokenId(eloBin(blackElo, 'b')),
      ...this.encodeMoves(uci),
      this.tokenId(resultToken),
      EOS_ID,
    ];
    return ids.length <= maxLen ? ids : ids.slice(0, maxLen);
  }

  /** Token strings for a sequence of ids; out-of-range ids decode to `<unk>`. */
  decode(ids: readonly number[]): string[] {
    return ids.map((id) => this.tokens[id] ?? '<unk>');
  }
}
