import { describe, expect, it } from 'vitest';
import {
  BOS_ID,
  EOS_ID,
  SPECIALS,
  SQUARES,
  UNK_ID,
  UciTokenizer,
  buildMoves,
  buildVocab,
  eloBin,
} from '../src/lib/chess-lm/tokenizer';
import { SAN_ALPHABET, SanCharTokenizer } from '../src/lib/chess-lm/san-chars';
import { loadBpe, type BpeFile } from '../src/lib/chess-lm/bpe';

const vocab = buildVocab();
const id = (token: string): number => vocab.indexOf(token);
const tokenizer = new UciTokenizer();

describe('buildVocab', () => {
  it('enumerates 64 squares file-major', () => {
    expect(SQUARES).toHaveLength(64);
    expect(SQUARES.slice(0, 9)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'b1']);
    expect(SQUARES[63]).toBe('h8');
  });

  it('has 2030 tokens: 8 specials, 54 Elo bins, 1792 moves and 176 promotions', () => {
    expect(vocab).toHaveLength(2030);
    expect(buildMoves()).toHaveLength(1968);
    expect(buildMoves().filter((move) => move.length === 4)).toHaveLength(1792);
    expect(buildMoves().filter((move) => move.length === 5)).toHaveLength(176);
    expect(new Set(vocab).size).toBe(2030);
  });

  it('places the specials at ids 0-7', () => {
    expect(vocab.slice(0, 8)).toEqual([
      '<pad>',
      '<bos>',
      '<eos>',
      '<mask>',
      '<unk>',
      '<1-0>',
      '<0-1>',
      '<1/2>',
    ]);
    expect(SPECIALS).toEqual(vocab.slice(0, 8));
  });

  it('places the Elo bins at ids 8-61 and moves from 62', () => {
    expect(id('<w0600>')).toBe(8);
    expect(id('<w1800>')).toBe(20);
    expect(id('<w3200>')).toBe(34);
    expect(id('<b0600>')).toBe(35);
    expect(id('<b1800>')).toBe(47);
    expect(id('<b3200>')).toBe(61);
    expect(vocab[62]).toBe('a1a2');
  });

  it('contains queen and knight moves and promotions, but not other moves', () => {
    for (const move of ['e2e4', 'g1f3', 'e7e8q', 'a1h8', 'h7g8n', 'a1a8', 'b1a3', 'e2e1r']) {
      expect(id(move), move).toBeGreaterThanOrEqual(62);
    }
    for (const move of ['a1b4', 'a1c4', 'a1a1', 'e2e4q', 'a7c8q', 'e7e8k', 'e6e7q']) {
      expect(id(move), move).toBe(-1);
    }
  });

  it('orders the promotions as white a7 first, then black, by target square and q r b n', () => {
    const promotions = buildMoves().filter((move) => move.length === 5);
    expect(promotions.slice(0, 8)).toEqual([
      'a7a8q',
      'a7a8r',
      'a7a8b',
      'a7a8n',
      'a7b8q',
      'a7b8r',
      'a7b8b',
      'a7b8n',
    ]);
    expect(promotions[8]).toBe('b7a8q');
    expect(promotions[88]).toBe('a2a1q');
    expect(promotions[175]).toBe('h2h1n');
  });
});

describe('eloBin', () => {
  it('floors to hundreds and clamps to [600, 3299]', () => {
    expect(eloBin(1850, 'w')).toBe('<w1800>');
    expect(eloBin(1899, 'b')).toBe('<b1800>');
    expect(eloBin(100, 'w')).toBe('<w0600>');
    expect(eloBin(599, 'w')).toBe('<w0600>');
    expect(eloBin(600, 'w')).toBe('<w0600>');
    expect(eloBin(3299, 'b')).toBe('<b3200>');
    expect(eloBin(3500, 'b')).toBe('<b3200>');
  });
});

describe('UciTokenizer', () => {
  it('encodes a game as bos, Elo bins, moves, result, eos', () => {
    expect(tokenizer.encodeGame('e2e4 e7e5', 1850, 1920, '1-0')).toEqual([
      1,
      20,
      48,
      id('e2e4'),
      id('e7e5'),
      5,
      2,
    ]);
    expect(tokenizer.encodeGame('e2e4', 1000, 1000, '0-1').at(-2)).toBe(6);
    expect(tokenizer.encodeGame('e2e4', 1000, 1000, '1/2-1/2').at(-2)).toBe(7);
    expect(() => tokenizer.encodeGame('e2e4', 1000, 1000, '*')).toThrow(/unknown result/);
  });

  it('maps unknown moves to <unk>', () => {
    expect(tokenizer.encodeMoves('e2e4 zz99 e7e5')).toEqual([id('e2e4'), UNK_ID, id('e7e5')]);
  });

  it('cuts to the first maxLen ids like Python (no <eos> when the game does not fit)', () => {
    const moves = Array.from({ length: 300 }, (_, i) => (i % 2 === 0 ? 'g1f3' : 'g8f6')).join(' ');
    const full = tokenizer.encodeGame(moves, 1500, 1500, '1/2-1/2', 10_000);
    expect(full).toHaveLength(305);
    expect(full.at(-1)).toBe(EOS_ID);
    const truncated = tokenizer.encodeGame(moves, 1500, 1500, '1/2-1/2');
    expect(truncated).toHaveLength(200);
    expect(truncated).toEqual(full.slice(0, 200));
    expect(truncated[0]).toBe(BOS_ID);
    expect(truncated.at(-1)).toBe(id('g1f3'));
    expect(tokenizer.encodeGame('e2e4 e7e5', 1850, 1920, '1-0', 7)).toHaveLength(7);
    expect(tokenizer.encodeGame('e2e4 e7e5', 1850, 1920, '1-0', 7).at(-1)).toBe(EOS_ID);
  });

  it('decodes back to the token strings', () => {
    const ids = tokenizer.encodeGame('e2e4 e7e5 g1f3', 1850, 1920, '1-0');
    expect(tokenizer.decode(ids)).toEqual([
      '<bos>',
      '<w1800>',
      '<b1900>',
      'e2e4',
      'e7e5',
      'g1f3',
      '<1-0>',
      '<eos>',
    ]);
    expect(tokenizer.decode(tokenizer.encodeMoves('e2e4 a1b4'))).toEqual(['e2e4', '<unk>']);
    expect(tokenizer.size).toBe(2030);
  });

  it('accepts a custom token list', () => {
    const custom = new UciTokenizer(['<pad>', '<bos>', '<eos>', '<mask>', '<unk>', 'e2e4']);
    expect(custom.encodeMoves('e2e4 e7e5')).toEqual([5, UNK_ID]);
  });
});

describe('SanCharTokenizer', () => {
  const san = new SanCharTokenizer();

  it('has the 3 specials then the 32-symbol alphabet', () => {
    expect(SAN_ALPHABET).toHaveLength(32);
    expect(san.size).toBe(35);
    expect(san.encode(' ')).toEqual([1, 3, 2]);
    expect(san.encode('#')).toEqual([1, 4, 2]);
    expect(san.encode('/')).toEqual([1, 34, 2]);
  });

  it('round-trips numbered SAN wrapped in <bos> and <eos>', () => {
    const text = '1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.O-O Nf6 5.Qe2 Bc5 6.Nxe5 Nxe5 7.d4 Bd6 8.f4 1-0';
    const ids = san.encode(text);
    expect(ids).toHaveLength(text.length + 2);
    expect(ids[0]).toBe(1);
    expect(ids.at(-1)).toBe(2);
    expect(san.decode(ids)).toBe(text);
    expect(san.decode(ids.slice(1, -1))).toBe(text);
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => san.encode('1.e4!')).toThrow(/alphabet/);
  });
});

describe('BpeTokenizer', () => {
  const file: BpeFile = {
    model: {
      type: 'BPE',
      unk_token: '<unk>',
      vocab: {
        '<pad>': 0,
        '<bos>': 1,
        '<eos>': 2,
        '<unk>': 3,
        e: 4,
        '2': 5,
        '4': 6,
        '7': 7,
        '5': 8,
        e2: 9,
        e4: 10,
        e2e4: 11,
        e7: 12,
        e5: 13,
        e7e5: 14,
        'e2e4 e7e5': 15,
      },
      merges: ['e 2', 'e 4', 'e2 e4', 'e 7', 'e 5', 'e7 e5'],
    },
    added_tokens: [{ id: 1, content: '<bos>', special: true }],
  };

  it('splits on whitespace and merges by rank', () => {
    const bpe = loadBpe(file);
    expect(bpe.tokenize('e2e4  e7e5\n')).toEqual(['e2e4', 'e7e5']);
    expect(bpe.encode('e2e4 e7e5')).toEqual([11, 14]);
    expect(bpe.encode('e2e5')).toEqual([9, 13]);
    expect(bpe.encode('2e')).toEqual([5, 4]);
    expect(bpe.decode([11, 14, 99])).toEqual(['e2e4', 'e7e5', '<unk>']);
    expect(bpe.size).toBe(16);
  });

  it('maps unknown characters to <unk> and matches added tokens whole', () => {
    const bpe = loadBpe(file);
    expect(bpe.encode('e2x4')).toEqual([9, 3, 6]);
    expect(bpe.encode('<bos>e2e4 <bos>')).toEqual([1, 11, 1]);
  });

  it('accepts merges as pairs and skips merges outside the vocabulary', () => {
    const pairs: BpeFile = {
      model: {
        ...file.model,
        merges: [
          ['e', '2'],
          ['e', '4'],
          ['e2', 'e4'],
          ['e2e4', 'zz'],
        ],
      },
    };
    expect(loadBpe(pairs).encode('e2e4 e7e5')).toEqual([11, 4, 7, 4, 8]);
  });

  it('merges the leftmost occurrence first on equal rank', () => {
    const bpe = loadBpe({
      model: {
        unk_token: '<unk>',
        vocab: { '<unk>': 0, a: 1, aa: 2, aaa: 3 },
        merges: ['a a', 'aa a'],
      },
    });
    expect(bpe.tokenize('aaa')).toEqual(['aaa']);
    expect(bpe.tokenize('aaaa')).toEqual(['aa', 'aa']);
    expect(bpe.tokenize('aaaaa')).toEqual(['aa', 'aaa']);
  });
});
