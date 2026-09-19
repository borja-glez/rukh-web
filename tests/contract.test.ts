import { describe, expect, it } from 'vitest';
import { UciTokenizer } from '../src/lib/chess-lm';
import {
  assertInRange,
  assertScalarOutput,
  assertVocab,
  declaredVocab,
  readContract,
  readEncoderContract,
  BLUNDER_OUTPUT,
  BLUNDER_RANGE,
  DECLARED_SOURCE,
  ENCODER_OUTPUTS,
  RUN_SOURCE,
  VALUE_OUTPUT,
  VALUE_RANGE,
  type SessionLike,
} from '../src/lib/contract';
import { DEFAULT_BLOCK, ENCODER_BLOCK, stageBlock, TEST_STAGE } from '../src/lib/registry';

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

/** A session that reports the encoder's two outputs, with the shapes ORT would declare. */
function encoderSession(
  names: readonly string[] = ENCODER_OUTPUTS,
  shapes?: Record<string, readonly (number | string)[]>,
): SessionLike {
  return {
    outputNames: names,
    outputMetadata: shapes
      ? names.map((name) => ({ name, isTensor: true, shape: shapes[name] }))
      : undefined,
  };
}

describe("the encoder's contract", () => {
  it('accepts the graph the exporter writes: value and blunder, one number each', () => {
    expect(readEncoderContract(encoderSession(), ENCODER_BLOCK)).toEqual({
      block: ENCODER_BLOCK,
      outputs: [VALUE_OUTPUT, BLUNDER_OUTPUT],
    });
    // `[batch]` is what ORT declares for the squeezed heads: symbolic, so nothing to check yet.
    expect(
      readEncoderContract(
        encoderSession(ENCODER_OUTPUTS, { value: ['batch'], blunder: ['batch'] }),
        ENCODER_BLOCK,
      ).outputs,
    ).toEqual([VALUE_OUTPUT, BLUNDER_OUTPUT]);
    // And `(B, 1)` is accepted just as well: one number per position either way.
    expect(
      readEncoderContract(
        encoderSession(ENCODER_OUTPUTS, { value: ['batch', 1], blunder: ['batch', 1] }),
        ENCODER_BLOCK,
      ).block,
    ).toBe(ENCODER_BLOCK);
  });

  it('refuses a file that is not the encoder of the bar', () => {
    // The decoder's own graph: one output, called something else.
    expect(() => readEncoderContract(session(['batch', 2030]), ENCODER_BLOCK)).toThrow(/logits/);
    expect(() => readEncoderContract(encoderSession(['value']), ENCODER_BLOCK)).toThrow(/value/);
    expect(() =>
      readEncoderContract(encoderSession(['value', 'blunder', 'result']), ENCODER_BLOCK),
    ).toThrow(/result/);
    try {
      readEncoderContract(encoderSession(['valor', 'error']), ENCODER_BLOCK);
      expect.unreachable('a graph with other outputs must not be accepted');
    } catch (error) {
      // The message is read in the panel by a player, so it is in Spanish and names both sides.
      const message = (error as Error).message;
      expect(message).toContain('value y blunder');
      expect(message).toContain('valor, error');
    }
  });

  it('refuses a head that answers more than one number per position', () => {
    expect(() =>
      readEncoderContract(
        encoderSession(ENCODER_OUTPUTS, { value: ['batch', 1], blunder: ['batch', 3] }),
        ENCODER_BLOCK,
      ),
    ).toThrow(new RegExp(DECLARED_SOURCE));
    // The declared shape is usually symbolic, so the real width is checked on every answer.
    expect(() => assertScalarOutput(1, 'value', RUN_SOURCE)).not.toThrow();
    expect(() => assertScalarOutput(2, 'value', RUN_SOURCE)).toThrow(/value/);
  });

  it('refuses a length the squares scheme could not have produced', () => {
    expect(() => readEncoderContract(encoderSession(), 0)).toThrow(/encoder/);
    expect(() => readEncoderContract(encoderSession(), 1.5)).toThrow(/contexto/);
  });

  it('checks that each head answered inside the range its activation can produce', () => {
    expect(() => assertInRange(-1, VALUE_OUTPUT, VALUE_RANGE)).not.toThrow();
    expect(() => assertInRange(0.42, VALUE_OUTPUT, VALUE_RANGE)).not.toThrow();
    expect(() => assertInRange(1.5, VALUE_OUTPUT, VALUE_RANGE)).toThrow(/value/);
    expect(() => assertInRange(Number.NaN, VALUE_OUTPUT, VALUE_RANGE)).toThrow(/value/);
    // `blunder` is already a probability: the sigmoid is inside the graph.
    expect(() => assertInRange(0, BLUNDER_OUTPUT, BLUNDER_RANGE)).not.toThrow();
    expect(() => assertInRange(1, BLUNDER_OUTPUT, BLUNDER_RANGE)).not.toThrow();
    expect(() => assertInRange(-0.1, BLUNDER_OUTPUT, BLUNDER_RANGE)).toThrow(/blunder/);
    expect(() => assertInRange(4.2, BLUNDER_OUTPUT, BLUNDER_RANGE)).toThrow(/blunder/);
  });
});
