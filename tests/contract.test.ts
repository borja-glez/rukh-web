import { describe, expect, it } from 'vitest';
import { UciTokenizer } from '../src/lib/chess-lm';
import {
  assertVocab,
  declaredVocab,
  readContract,
  DECLARED_SOURCE,
  RUN_SOURCE,
  type SessionLike,
} from '../src/lib/contract';
import { DEFAULT_BLOCK, stageBlock, TEST_STAGE } from '../src/lib/registry';

/** A session that reports one output with the given shape (undefined = no metadata at all). */
function session(shape?: readonly (number | string)[]): SessionLike {
  return {
    outputNames: ['logits'],
    outputMetadata: shape ? [{ name: 'logits', isTensor: true, shape }] : undefined,
  };
}

const VOCAB = new UciTokenizer().size;

describe('the model contract', () => {
  it('reads the fixed output width the file declares', () => {
    expect(declaredVocab(session(['batch', 2030]))).toBe(2030);
    expect(declaredVocab(session([1, 2030]))).toBe(2030);
  });

  it('answers null when the width is symbolic, absent or nonsense', () => {
    expect(declaredVocab(session(['batch', 'vocab']))).toBeNull();
    expect(declaredVocab(session([]))).toBeNull();
    expect(declaredVocab(session())).toBeNull();
    expect(declaredVocab(session(['batch', -1]))).toBeNull();
    expect(declaredVocab(session(['batch', 2030.5]))).toBeNull();
  });

  it('ignores the metadata of another output', () => {
    expect(declaredVocab({ outputNames: ['logits'], outputMetadata: [] })).toBeNull();
    expect(
      declaredVocab({
        outputNames: ['logits'],
        outputMetadata: [{ name: 'hidden', shape: ['batch', 512] }],
      }),
    ).toBeNull();
  });

  it('accepts a session whose declared width is the tokenizer vocabulary', () => {
    expect(readContract(session(['batch', VOCAB]), VOCAB, DEFAULT_BLOCK)).toEqual({
      block: DEFAULT_BLOCK,
      vocab: VOCAB,
    });
  });

  it('refuses a session whose declared width is not the vocabulary', () => {
    expect(() => readContract(session(['batch', 1968]), VOCAB, DEFAULT_BLOCK)).toThrow(/1968/);
    // The message is what a player reads in the panel, so it is in Spanish and names both sides.
    try {
      readContract(session(['batch', 1968]), VOCAB, DEFAULT_BLOCK);
      expect.unreachable('a wrong vocabulary must not be accepted');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('no encaja con el tokenizador');
      expect(message).toContain(DECLARED_SOURCE);
      expect(message).toContain(String(VOCAB));
    }
  });

  it('defers to the first run when the width is symbolic', () => {
    // ORT reports a symbolic output shape for many graphs, so nothing can be checked at load
    // time; the contract carries the expected width and `logits` enforces it on every answer.
    const contract = readContract(session(['batch', 'vocab']), VOCAB, DEFAULT_BLOCK);
    expect(contract.vocab).toBe(VOCAB);
    expect(() => assertVocab(VOCAB, contract.vocab, RUN_SOURCE)).not.toThrow();
    expect(() => assertVocab(1968, contract.vocab, RUN_SOURCE)).toThrow(new RegExp(RUN_SOURCE));
  });

  it('refuses a context the prompt could not fit in', () => {
    expect(() => readContract(session(), VOCAB, 0)).toThrow(/contexto/);
    expect(() => readContract(session(), VOCAB, 1.5)).toThrow(/contexto/);
  });

  it('carries the block of the stage that was loaded', () => {
    expect(readContract(session(), VOCAB, stageBlock(TEST_STAGE)).block).toBe(DEFAULT_BLOCK);
    expect(readContract(session(), VOCAB, 64).block).toBe(64);
  });
});
