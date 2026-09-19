import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BLOCK,
  defaultStageId,
  findStage,
  modelUrl,
  selectableStages,
  stageBlock,
  STAGES,
  STAGE_SIZE_MB,
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
