import { describe, expect, it } from 'vitest';
import { SQUARE_TOKENS } from '../src/lib/chess-lm/squares';
import {
  ADAPTERS,
  ADAPTER_BYTES,
  DEFAULT_BLOCK,
  ENCODER_BLOCK,
  ENCODER_SIZE_MB,
  ENCODER_STAGES,
  adapterUrl,
  adaptersFor,
  defaultEncoderId,
  defaultStageId,
  findAdapter,
  encoderBlock,
  findEncoderStage,
  findStage,
  modelUrl,
  NO_ADAPTER,
  selectableStages,
  stageBlock,
  totalSizeMb,
  STAGES,
  STAGE_SIZE_MB,
  TEST_ADAPTER,
  TEST_ENCODER_STAGE,
  TEST_LORA_STAGE,
  TEST_STAGE,
} from '../src/lib/registry';

describe('stage registry', () => {
  it('keeps the mock first and every other stage an ONNX one', () => {
    expect(STAGES.map((stage) => stage.id)).toEqual([
      'mock',
      'tiny-int8',
      'small-fp16',
      'small-int8',
      'medium-fp16',
      'medium-int8',
      'medium-dpo-fp16',
      'medium-elo-fp16',
      'medium-elo-int8',
      'medium-lora-fp16',
      'medium-lora-int8',
    ]);
    expect(STAGES[0].kind).toBe('mock');
    expect(STAGES.slice(1).every((stage) => stage.kind === 'onnx')).toBe(true);
  });

  it('never defaults to a stage that costs hundreds of megabytes', () => {
    // `medium` is offered but chosen, never assumed: 221 MB is not something to spend on
    // somebody's connection because they opened the page.
    for (const conditions of [{}, { webgpu: true }, { webgpu: false }, { saveData: true }]) {
      const chosen = findStage(defaultStageId(conditions));
      expect(chosen?.sizeMb ?? 0).toBeLessThanOrEqual(STAGE_SIZE_MB['small-fp16']);
    }
  });

  it('declares the measured sizes in one place', () => {
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

  it('serves fp16 wherever WebGPU runs, phone or not', () => {
    expect(defaultStageId({})).toBe('small-fp16');
    expect(defaultStageId({ webgpu: true })).toBe('small-fp16');
    // The regression that matters: a phone with WebGPU used to be downgraded to int8, which
    // changes the move in 4.6 % of positions and is not the model the cards describe.
    expect(defaultStageId({ mobile: true, webgpu: true })).toBe('small-fp16');
  });

  it('falls back to int8 only without WebGPU or with data saver on', () => {
    expect(defaultStageId({ webgpu: false })).toBe('small-int8');
    expect(defaultStageId({ mobile: true, webgpu: false })).toBe('small-int8');
    expect(defaultStageId({ saveData: true })).toBe('small-int8');
    // Data saver wins over a working WebGPU: it is the user asking for fewer bytes.
    expect(defaultStageId({ saveData: true, webgpu: true })).toBe('small-int8');
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

  it('declares the measured encoder sizes in one place', () => {
    for (const stage of ENCODER_STAGES) {
      expect(stage.sizeMb).toBe(ENCODER_SIZE_MB[stage.id as keyof typeof ENCODER_SIZE_MB]);
    }
    // Measured on the published files, not estimated: 78 745 459 and 43 393 427 bytes.
    expect(ENCODER_SIZE_MB['encoder-fp16']).toBe(79);
    expect(ENCODER_SIZE_MB['encoder-int8']).toBe(43);
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
    expect(totalSizeMb(findStage('small-fp16'), findEncoderStage('encoder-fp16'))).toBe(158);
    expect(totalSizeMb(findStage('small-int8'), findEncoderStage('encoder-int8'))).toBe(86);
    expect(totalSizeMb(TEST_STAGE, TEST_ENCODER_STAGE)).toBe(0.3);
    expect(totalSizeMb(undefined, undefined)).toBe(0);
  });
});

describe('style adapters', () => {
  it('offers none for a stage whose graph does not take the factors', () => {
    expect(adaptersFor(TEST_STAGE)).toEqual([]);
    for (const stage of STAGES) {
      if (!stage.adaptable) expect(adaptersFor(stage)).toEqual([]);
    }
  });

  it('offers only adapters trained for the stage they are shown on', () => {
    // An adapter is a correction to *these* weights, so the same file over another checkpoint is
    // noise. The list is the cheap half of that check; the worker's length check is the other.
    const offered = adaptersFor(TEST_LORA_STAGE);
    expect(offered).toHaveLength(1);
    expect(offered[0].id).toBe(TEST_ADAPTER.id);
    for (const adapter of ADAPTERS) {
      for (const stage of adapter.stages) {
        expect(findStage(stage)?.adaptable, `${adapter.id} on ${stage}`).toBe(true);
      }
    }
  });

  it('serves the published adapters from the Hub and the toy one from this origin', () => {
    expect(adapterUrl(ADAPTERS[0])).toBe(
      `https://huggingface.co/${ADAPTERS[0].repo}/resolve/main/web/adapter.bin`,
    );
    expect(adapterUrl(TEST_ADAPTER)).toBe('/test/toy-lora.bin');
  });

  it('answers null for no adapter and for anything unknown', () => {
    expect(findAdapter(NO_ADAPTER)).toBeNull();
    expect(findAdapter('lora-nf3')).toBeNull();
    expect(findAdapter('lora-e4')?.repo).toBe('chorcat/rukh-lora-e4');
  });

  it('declares the measured size of an adapter in one place', () => {
    for (const adapter of ADAPTERS) expect(adapter.sizeBytes).toBe(ADAPTER_BYTES);
  });
});
