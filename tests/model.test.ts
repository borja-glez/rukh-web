import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { EOS_ID, UciTokenizer, eloBin } from '../src/lib/chess-lm';
import { applyMove, fromFen, newGame, type GameState } from '../src/lib/game';
import {
  argmax,
  buildPrompt,
  CONTEXT,
  filterLogits,
  historyUci,
  legalTokenIds,
  proposeMove,
  softmax,
  type LogitsSource,
} from '../src/lib/model';

const tokenizer = new UciTokenizer();
const VOCAB = tokenizer.size;

/** A fake worker: it answers the crafted logits and records what it was asked. */
function fakeWorker(logits: Float32Array): LogitsSource & { prompts: number[][] } {
  const prompts: number[][] = [];
  return {
    prompts,
    async logits(ids: number[]) {
      prompts.push(ids);
      return { data: logits.slice(), inferMs: 1.5 };
    },
  };
}

function zeros(): Float32Array {
  return new Float32Array(VOCAB);
}

/** Crafted logits: every named token gets its value, everything else stays at 0. */
function crafted(values: Record<string, number>): Float32Array {
  const logits = zeros();
  for (const [token, value] of Object.entries(values)) {
    logits[tokenizer.tokenId(token)] = value;
  }
  return logits;
}

/** A deterministic uniform stream, so "1000 draws" means 1000 different draws. */
function sweep(count: number): () => number {
  let step = 0;
  return () => (step++ + 0.5) / count;
}

function afterMoves(sans: string[]): GameState {
  let state = newGame();
  const chess = new Chess();
  for (const san of sans) {
    const move = chess.move(san);
    state = applyMove(state, { from: move.from, to: move.to })!;
  }
  return state;
}

describe('prompt', () => {
  it('starts with <bos> and both Elo bins', () => {
    const ids = buildPrompt([], 1800, 1500, tokenizer);
    expect(tokenizer.decode(ids)).toEqual(['<bos>', '<w1800>', '<b1500>']);
    expect(tokenizer.tokenId(eloBin(1849, 'w'))).toBe(ids[1]);
  });

  it('keeps the header and drops the oldest moves past the context', () => {
    const moves = Array.from({ length: CONTEXT + 40 }, () => 'e2e4');
    const ids = buildPrompt(moves, 1800, 1800, tokenizer);
    expect(ids).toHaveLength(CONTEXT);
    expect(tokenizer.decode(ids.slice(0, 3))).toEqual(['<bos>', '<w1800>', '<b1800>']);
    expect(ids.slice(3).every((id) => id === tokenizer.tokenId('e2e4'))).toBe(true);
  });

  it('turns the SAN history into UCI', () => {
    expect(historyUci(afterMoves(['e4', 'e5', 'Nf3']))).toEqual(['e2e4', 'e7e5', 'g1f3']);
  });
});

describe('legal token ids', () => {
  it('finds the 20 opening moves and every one decodes to a legal move', () => {
    const ids = legalTokenIds(newGame().fen, tokenizer);
    expect(ids).toHaveLength(20);
    const chess = new Chess();
    for (const id of ids) {
      const uci = tokenizer.tokens[id];
      expect(() => chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) })).not.toThrow();
      chess.undo();
    }
    expect([...ids]).toEqual([...ids].sort((a, b) => a - b));
  });

  it('includes the promotion piece', () => {
    const ids = legalTokenIds('8/4P3/8/8/8/8/8/K6k w - - 0 1', tokenizer);
    expect(ids.map((id) => tokenizer.tokens[id])).toContain('e7e8q');
  });
});

describe('filtering', () => {
  it('masks every token that is not a legal move', () => {
    const filtered = filterLogits(zeros(), [10, 20], {
      temperature: 1,
      topK: null,
      maskIllegal: true,
    });
    expect(filtered[10]).toBe(0);
    expect(filtered[20]).toBe(0);
    expect(filtered[11]).toBe(-Infinity);
  });

  it('divides by the temperature only when it is positive', () => {
    const logits = new Float32Array([1, 2, 3]);
    const options = { topK: null, maskIllegal: false };
    expect([...filterLogits(logits, [], { ...options, temperature: 0.5 })]).toEqual([2, 4, 6]);
    expect([...filterLogits(logits, [], { ...options, temperature: 0 })]).toEqual([1, 2, 3]);
  });

  it('truncates to the top k', () => {
    const logits = new Float32Array([5, 1, 4, 2, 3]);
    const filtered = filterLogits(logits, [], { temperature: 1, topK: 2, maskIllegal: false });
    expect([...filtered]).toEqual([5, -Infinity, 4, -Infinity, -Infinity]);
  });

  it('softmax turns -inf into exactly zero', () => {
    const probs = softmax(Float64Array.from([0, -Infinity, 0]));
    expect([...probs]).toEqual([0.5, 0, 0.5]);
    expect(argmax(Float64Array.from([1, 9, 9]))).toBe(1);
  });
});

describe('proposeMove', () => {
  const request = { state: newGame(), whiteElo: 1800, blackElo: 1800 };

  it('never plays an illegal move with the mask on', async () => {
    // The network is convinced about `a1a8`, which is not legal in the opening.
    const worker = fakeWorker(crafted({ a1a8: 40, '<eos>': 30, e2e4: 1 }));
    const random = sweep(1000);
    for (let draw = 0; draw < 1000; draw += 1) {
      const proposal = await proposeMove(worker, {
        ...request,
        options: { temperature: 1, topK: null, maskIllegal: true, random },
      });
      expect(proposal.legal).toBe(true);
      expect(proposal.move).not.toBeNull();
      expect(proposal.rawToken).not.toBe('a1a8');
      const chess = new Chess();
      expect(() => chess.move({ from: proposal.move!.from, to: proposal.move!.to })).not.toThrow();
    }
    expect(worker.prompts[0]).toEqual(buildPrompt([], 1800, 1800, tokenizer));
  });

  it('temperature 0 is the argmax of the legal moves', async () => {
    const worker = fakeWorker(crafted({ a1a8: 40, g1f3: 9, e2e4: 8 }));
    const proposal = await proposeMove(worker, {
      ...request,
      options: { temperature: 0, topK: null, maskIllegal: true },
    });
    expect(proposal.rawToken).toBe('g1f3');
    expect(proposal.move).toEqual({ from: 'g1', to: 'f3', promotion: undefined });
    expect(proposal.legal).toBe(true);
    expect(proposal.masked).toBe(true);
  });

  it('surfaces the raw token and legal:false without the mask', async () => {
    const worker = fakeWorker(crafted({ a1a8: 40, e2e4: 8 }));
    const proposal = await proposeMove(worker, {
      ...request,
      options: { temperature: 0, topK: null, maskIllegal: false },
    });
    expect(proposal.rawToken).toBe('a1a8');
    expect(proposal.legal).toBe(false);
    expect(proposal.move).toBeNull();
    expect(proposal.masked).toBe(false);
  });

  it('reports a special token as an illegal proposal', async () => {
    const logits = zeros();
    logits[EOS_ID] = 50;
    const worker = fakeWorker(logits);
    const proposal = await proposeMove(worker, {
      ...request,
      options: { temperature: 0, topK: null, maskIllegal: false },
    });
    expect(proposal.rawToken).toBe('<eos>');
    expect(proposal.legal).toBe(false);
    expect(proposal.move).toBeNull();
  });

  it('reads the top five off the distribution it sampled', async () => {
    const worker = fakeWorker(crafted({ e2e4: 5, d2d4: 4, g1f3: 3, b1c3: 2, c2c4: 1, a1a8: 9 }));
    const proposal = await proposeMove(worker, {
      ...request,
      options: { temperature: 1, topK: 5, maskIllegal: true, random: () => 0 },
    });
    expect(proposal.top5.map((entry) => entry.uci)).toEqual([
      'e2e4',
      'd2d4',
      'g1f3',
      'b1c3',
      'c2c4',
    ]);
    const total = proposal.top5.reduce((sum, entry) => sum + entry.prob, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(proposal.top5[0].prob).toBeGreaterThan(proposal.top5[4].prob);
  });

  it('times the three stages and passes the inference time through', async () => {
    const worker = fakeWorker(crafted({ e2e4: 5 }));
    const proposal = await proposeMove(worker, request);
    expect(proposal.timings.inferMs).toBe(1.5);
    expect(proposal.timings.tokenizeMs).toBeGreaterThanOrEqual(0);
    expect(proposal.timings.sampleMs).toBeGreaterThanOrEqual(0);
  });

  it('asks for nothing in a finished position', async () => {
    const worker = fakeWorker(crafted({ e2e4: 5 }));
    const mate = fromFen('7k/5QK1/8/8/8/8/8/8 b - - 0 1');
    const proposal = await proposeMove(worker, { ...request, state: mate });
    expect(worker.prompts).toHaveLength(0);
    expect(proposal.move).toBeNull();
    expect(proposal.legal).toBe(false);
  });
});
