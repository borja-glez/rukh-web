// Turning a position into a move: tokenize the game, ask the worker for the next-token logits,
// mask the illegal tokens with chess.js, sample and report what the network actually proposed.
//
// This is the TypeScript twin of `rukh/src/rukh/infer/sampler.py` and follows it step by step:
// the legality mask first (`-inf` on every token that is not a legal move), then the
// temperature, then the top-k truncation, then the softmax; `temperature == 0` is argmax over
// the filtered logits; `top5` is read off the very distribution that was sampled. Without the
// mask the raw token is returned as it came out of the network with `legal: false`, which is the
// honest way to show the legality rate.
import { Chess } from 'chess.js';
import { UciTokenizer, eloBin, BOS_ID } from './chess-lm';
import type { GameState, Move, Promotion } from './game';

/**
 * Fallback context window, used only until a session reports its own. The real one travels in the
 * worker's `ready` message (`ReadyMessage.block`, from the registry entry of the stage) and is
 * passed in as `MoveRequest.context`: a model with another `block` would otherwise be fed a prompt
 * it cannot read, or be cropped for nothing.
 */
export const CONTEXT = 200;

/** `<bos>`, the white Elo bin and the black Elo bin. */
export const HEADER_TOKENS = 3;

/** How many proposals the "qué ha salido por la red" panel shows. */
export const TOP_N = 5;

export interface SampleOptions {
  temperature: number;
  topK: number | null;
  maskIllegal: boolean;
  /** Injected for the tests; defaults to `Math.random`. */
  random?: () => number;
}

export const DEFAULT_SAMPLE: SampleOptions = {
  temperature: 0.6,
  topK: 20,
  maskIllegal: true,
};

export interface TopEntry {
  uci: string;
  prob: number;
}

export interface Timings {
  tokenizeMs: number;
  inferMs: number;
  sampleMs: number;
}

export interface Proposal {
  /** The move to play, or `null` when the proposal is not legal (unmasked mode). */
  move: Move | null;
  /** The token the network sampled, legal or not (`e2e4`, `<eos>`, ...). */
  rawToken: string;
  legal: boolean;
  masked: boolean;
  top5: TopEntry[];
  timings: Timings;
}

export interface LogitsSource {
  logits(ids: number[]): Promise<{ data: Float32Array; inferMs: number }>;
}

export interface MoveRequest {
  state: GameState;
  /** Elo bin written in the header for White. */
  whiteElo: number;
  /** Elo bin written in the header for Black. */
  blackElo: number;
  options?: Partial<SampleOptions>;
  tokenizer?: UciTokenizer;
  /** The model's context window; defaults to `CONTEXT` when no session has reported one. */
  context?: number;
}

const SHARED_TOKENIZER = new UciTokenizer();

/** The game so far as UCI moves (`e2e4`), replaying the SAN history on a chess.js board. */
export function historyUci(state: GameState): string[] {
  const chess = new Chess(state.start);
  const moves: string[] = [];
  for (const san of state.history) {
    const move = chess.move(san);
    moves.push(`${move.from}${move.to}${move.promotion ?? ''}`);
  }
  return moves;
}

/**
 * `[<bos>, <wXXXX>, <bXXXX>, ...moves]` cropped to `maxLen`. When the game is longer than the
 * context the **oldest** moves are dropped: the header stays (it conditions the style) and the
 * recent position is what the decoder needs.
 */
export function buildPrompt(
  moves: readonly string[],
  whiteElo: number,
  blackElo: number,
  tokenizer: UciTokenizer = SHARED_TOKENIZER,
  maxLen = CONTEXT,
): number[] {
  const header = [
    BOS_ID,
    tokenizer.tokenId(eloBin(whiteElo, 'w')),
    tokenizer.tokenId(eloBin(blackElo, 'b')),
  ];
  const room = Math.max(0, maxLen - header.length);
  const recent = moves.length > room ? moves.slice(moves.length - room) : moves;
  return [...header, ...recent.map((move) => tokenizer.tokenId(move))];
}

/** Sorted vocabulary ids of every legal move in `fen` (a move missing from the vocab is skipped). */
export function legalTokenIds(fen: string, tokenizer: UciTokenizer = SHARED_TOKENIZER): number[] {
  const chess = new Chess(fen);
  const ids = new Set<number>();
  for (const move of chess.moves({ verbose: true })) {
    const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
    const id = tokenizer.tokenId(uci);
    // `tokenId` answers `<unk>` for anything outside the vocabulary; a real move never is.
    if (tokenizer.tokens[id] === uci) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * The legality mask, the temperature and the top-k truncation, in that order — the same order
 * and the same semantics as `_filtered_logits` in Python.
 */
export function filterLogits(
  logits: Float32Array | readonly number[],
  legal: readonly number[],
  options: SampleOptions,
): Float64Array {
  const out = Float64Array.from(logits);
  if (options.maskIllegal) {
    const keep = new Uint8Array(out.length);
    for (const id of legal) if (id < keep.length) keep[id] = 1;
    for (let i = 0; i < out.length; i += 1) if (!keep[i]) out[i] = -Infinity;
  }
  if (options.temperature > 0) {
    for (let i = 0; i < out.length; i += 1) out[i] /= options.temperature;
  }
  if (options.topK !== null) {
    const k = Math.min(options.topK, out.length);
    const sorted = Array.from(out).sort((a, b) => b - a);
    const threshold = sorted[k - 1];
    for (let i = 0; i < out.length; i += 1) if (out[i] < threshold) out[i] = -Infinity;
  }
  return out;
}

/** Softmax of already filtered logits; `-inf` entries come out as exactly 0. */
export function softmax(values: Float64Array): Float64Array {
  let max = -Infinity;
  for (const value of values) if (value > max) max = value;
  const out = new Float64Array(values.length);
  if (!Number.isFinite(max)) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const weight = Math.exp(values[i] - max);
    out[i] = weight;
    sum += weight;
  }
  if (sum > 0) for (let i = 0; i < out.length; i += 1) out[i] /= sum;
  return out;
}

/** Index drawn from `probs`, the `torch.multinomial` of one sample. */
export function sampleIndex(probs: Float64Array, random: () => number): number {
  const target = random();
  let cumulative = 0;
  for (let i = 0; i < probs.length; i += 1) {
    cumulative += probs[i];
    if (target < cumulative) return i;
  }
  // Rounding can leave the target just past the last bucket: answer the last non-zero entry.
  for (let i = probs.length - 1; i >= 0; i -= 1) if (probs[i] > 0) return i;
  return 0;
}

/** First index of the maximum, like `torch.argmax`. */
export function argmax(values: Float64Array): number {
  let best = 0;
  for (let i = 1; i < values.length; i += 1) if (values[i] > values[best]) best = i;
  return best;
}

function topEntries(probs: Float64Array, tokenizer: UciTokenizer, count: number): TopEntry[] {
  const indices = Array.from(probs, (prob, index) => ({ prob, index }))
    .filter((entry) => entry.prob > 0)
    .sort((a, b) => b.prob - a.prob || a.index - b.index)
    .slice(0, Math.min(count, probs.length));
  return indices.map((entry) => ({ uci: tokenizer.tokens[entry.index], prob: entry.prob }));
}

const MOVE_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/** A token as a move, or `null` for a special token (`<eos>`, an Elo bin, ...). */
export function asMove(token: string): Move | null {
  if (!MOVE_PATTERN.test(token)) return null;
  return {
    from: token.slice(0, 2),
    to: token.slice(2, 4),
    promotion: token.length === 5 ? (token[4] as Promotion) : undefined,
  };
}

function isLegal(fen: string, move: Move): boolean {
  const chess = new Chess(fen);
  try {
    chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    return true;
  } catch {
    return false;
  }
}

/**
 * One move from the model: tokenize, ask for the logits, mask, sample and report.
 *
 * `move` is `null` when the sampled token is not a legal move (only reachable with the mask
 * off, or when a masked position has no legal move at all, i.e. the game is over).
 */
export async function proposeMove(source: LogitsSource, request: MoveRequest): Promise<Proposal> {
  const tokenizer = request.tokenizer ?? SHARED_TOKENIZER;
  const options: SampleOptions = { ...DEFAULT_SAMPLE, ...request.options };
  const random = options.random ?? Math.random;

  const tokenizeStart = performance.now();
  const ids = buildPrompt(
    historyUci(request.state),
    request.whiteElo,
    request.blackElo,
    tokenizer,
    request.context ?? CONTEXT,
  );
  const legal = legalTokenIds(request.state.fen, tokenizer);
  const tokenizeMs = performance.now() - tokenizeStart;

  const empty: Proposal = {
    move: null,
    rawToken: '',
    legal: false,
    masked: options.maskIllegal,
    top5: [],
    timings: { tokenizeMs, inferMs: 0, sampleMs: 0 },
  };
  if (options.maskIllegal && legal.length === 0) return empty;

  const { data, inferMs } = await source.logits(ids);

  const sampleStart = performance.now();
  const filtered = filterLogits(data, legal, options);
  const probs = softmax(filtered);
  const tokenId = options.temperature === 0 ? argmax(filtered) : sampleIndex(probs, random);
  const rawToken = tokenizer.tokens[tokenId] ?? '<unk>';
  const move = asMove(rawToken);
  const legalMove = move !== null && isLegal(request.state.fen, move);
  const proposal: Proposal = {
    move: legalMove ? move : null,
    rawToken,
    legal: legalMove,
    masked: options.maskIllegal,
    top5: topEntries(probs, tokenizer, TOP_N),
    timings: { tokenizeMs, inferMs, sampleMs: performance.now() - sampleStart },
  };
  return proposal;
}
