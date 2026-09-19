import { describe, expect, it } from 'vitest';
import { SQUARE_TOKENS } from '../src/lib/chess-lm/squares';
import {
  DEFAULT_BLOCK,
  ENCODER_BLOCK,
  ENCODER_SIZE_MB,
  ENCODER_STAGES,
  defaultEncoderId,
  defaultStageId,
  encoderBlock,
  findEncoderStage,
  findStage,
  modelUrl,
  selectableStages,
  stageBlock,
  totalSizeMb,
  STAGES,
  STAGE_SIZE_MB,
  TEST_ENCODER_STAGE,
  TEST_STAGE,
} from '../src/lib/registry';

describe('stage registry', () => {
  it('keeps the mock first and lists the three ONNX stages', () => {
    expect(STAGES.map((stage) => stage.id)).toEqual([
      'mock',
      'tiny-int8',
      'small-fp16',
      'small-int8',
    ]);
    expect(STAGES[0].kind).toBe('mock');
    expect(STAGES.slice(1).every((stage) => stage.kind === 'onnx')).toBe(true);
  });

  it('declares the provisional sizes in one place', () => {
    for (const stage of STAGES.slice(1)) {
      expect(stage.sizeMb).toBe(STAGE_SIZE_MB[stage.id as keyof typeof STAGE_SIZE_MB]);
    }
    expect(STAGE_SIZE_MB['small-fp16']).toBeGreaterThan(STAGE_SIZE_MB['small-int8']);
  });

  it('declares the context of every ONNX stage', () => {
    // ORT Web cannot read the `rukh_block` metadata of the file, so this is the only place the
    // browser learns the context; `buildPrompt` crops to it instead of to a constant.
    for (const stage of [...STAGES.slice(1), TEST_STAGE]) {
      expect(stageBlock(stage)).toBe(DEFAULT_BLOCK);
    }
    expect(stageBlock({ ...TEST_STAGE, block: undefined })).toBe(DEFAULT_BLOCK);
    expect(stageBlock({ ...TEST_STAGE, block: 512 })).toBe(512);
  });

  it('builds the Hub URL of a stage', () => {
    expect(modelUrl(findStage('small-int8')!)).toBe(
      'https://huggingface.co/chorcat/rukh-small/resolve/main/onnx/model-int8.onnx',
    );
    expect(modelUrl(findStage('tiny-int8')!)).toBe(
      'https://huggingface.co/chorcat/rukh-tiny/resolve/main/onnx/model-int8.onnx',
    );
  });

  it('refuses to build a URL for a stage without a file', () => {
    expect(() => modelUrl(STAGES[0])).toThrow(/no model file/);
  });

  it('serves the toy model from this origin and hides it from the registry', () => {
    expect(STAGES).not.toContain(TEST_STAGE);
    expect(findStage('test')).toBe(TEST_STAGE);
    expect(modelUrl(TEST_STAGE)).toBe('/test/toy-decoder.onnx');
  });

  it('adds the current stage to the selector when it is not in the registry', () => {
    expect(selectableStages('mock')).toEqual(STAGES);
    expect(selectableStages('test')).toEqual([...STAGES, TEST_STAGE]);
  });

  it('defaults to int8 on mobile or with data saver on', () => {
    expect(defaultStageId({})).toBe('small-fp16');
    expect(defaultStageId({ mobile: true })).toBe('small-int8');
    expect(defaultStageId({ saveData: true })).toBe('small-int8');
  });

  it('answers undefined for an unknown stage', () => {
    expect(findStage('nope')).toBeUndefined();
  });
});

describe('encoder stages', () => {
  it('lists the two encoder exports and keeps them out of the play selector', () => {
    expect(ENCODER_STAGES.map((stage) => stage.id)).toEqual(['encoder-fp16', 'encoder-int8']);
    expect(ENCODER_STAGES.every((stage) => stage.kind === 'encoder')).toBe(true);
    // The "Etapa" selector is about who plays; the encoder never plays.
    for (const stage of ENCODER_STAGES) {
      expect(STAGES).not.toContain(stage);
      expect(findStage(stage.id)).toBeUndefined();
      expect(selectableStages(stage.id)).toEqual(STAGES);
    }
  });

  it('declares the provisional encoder sizes in one place', () => {
    for (const stage of ENCODER_STAGES) {
      expect(stage.sizeMb).toBe(ENCODER_SIZE_MB[stage.id as keyof typeof ENCODER_SIZE_MB]);
    }
    expect(ENCODER_SIZE_MB['encoder-fp16']).toBe(30);
    expect(ENCODER_SIZE_MB['encoder-int8']).toBe(15);
    expect(ENCODER_SIZE_MB['encoder-fp16']).toBeGreaterThan(ENCODER_SIZE_MB['encoder-int8']);
  });

  it('feeds every encoder stage the 69 tokens of the squares scheme', () => {
    expect(ENCODER_BLOCK).toBe(SQUARE_TOKENS);
    for (const stage of [...ENCODER_STAGES, TEST_ENCODER_STAGE]) {
      expect(encoderBlock(stage)).toBe(SQUARE_TOKENS);
    }
    expect(encoderBlock({ ...TEST_ENCODER_STAGE, block: undefined })).toBe(ENCODER_BLOCK);
  });

  it('builds the Hub URL of the encoder and serves the toy from this origin', () => {
    expect(modelUrl(findEncoderStage('encoder-fp16')!)).toBe(
      'https://huggingface.co/chorcat/rukh-encoder/resolve/main/onnx/model-fp16.onnx',
    );
    expect(modelUrl(findEncoderStage('encoder-int8')!)).toBe(
      'https://huggingface.co/chorcat/rukh-encoder/resolve/main/onnx/model-int8.onnx',
    );
    expect(modelUrl(TEST_ENCODER_STAGE)).toBe('/test/toy-encoder.onnx');
    expect(ENCODER_STAGES).not.toContain(TEST_ENCODER_STAGE);
  });

  it('defaults to the int8 encoder on mobile or with data saver on', () => {
    expect(defaultEncoderId({})).toBe('encoder-fp16');
    expect(defaultEncoderId({ mobile: true })).toBe('encoder-int8');
    expect(defaultEncoderId({ saveData: true })).toBe('encoder-int8');
  });

  it('answers undefined for an unknown encoder', () => {
    expect(findEncoderStage('nope')).toBeUndefined();
    expect(findEncoderStage('small-fp16')).toBeUndefined();
  });

  it('adds the two downloads up for the "both loaded" line', () => {
    expect(totalSizeMb(findStage('small-fp16'), findEncoderStage('encoder-fp16'))).toBe(110);
    expect(totalSizeMb(findStage('small-int8'), findEncoderStage('encoder-int8'))).toBe(55);
    expect(totalSizeMb(TEST_STAGE, TEST_ENCODER_STAGE)).toBe(0.3);
    expect(totalSizeMb(undefined, undefined)).toBe(0);
  });
});
