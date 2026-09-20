export type StageKind = 'mock' | 'onnx' | 'encoder';

export interface Stage {
  id: string;
  label: string;
  kind: StageKind;
  /** Download size in MB, shown in the consent step. 0 for stages that download nothing. */
  sizeMb: number;
  /** Hugging Face repo id, for `kind: 'onnx'` stages served from the Hub. */
  repo?: string;
  /** Path of the ONNX file inside the repo. */
  file?: string;
  /** Same-origin URL that replaces `repo`/`file` (only the toy model used by the E2E suite). */
  url?: string;
  /** True once the stage is trained with the Elo conditioning tokens (M4). */
  eloConditioned?: boolean;
  /**
   * Context window the stage was trained with (`DecoderConfig.block`). It lives here because ORT
   * Web does not expose the `rukh_block` metadata the exporter writes into the file, so the only
   * place the browser can learn it is the registry; `DEFAULT_BLOCK` when a stage omits it.
   */
  block?: number;
}

/** `DecoderConfig.block` of every model published so far. */
export const DEFAULT_BLOCK = 200;

/** The context window a stage plays with. */
export function stageBlock(stage: Stage): number {
  return stage.block ?? DEFAULT_BLOCK;
}

/**
 * Download sizes in MB. **Provisional**: they are the plan's estimates for the fp16 and int8
 * exports and the controller updates them here, in this one place, after the real export
 * (`rukh export ... --fp16 --int8`) reports the file sizes. They only drive the consent copy and
 * the progress bar fallback, never the download itself.
 */
export const STAGE_SIZE_MB = {
  'tiny-int8': 6,
  'small-fp16': 80,
  'small-int8': 40,
} as const;

/** Licence of every published Rukh model; shown before anything is downloaded. */
export const MODEL_LICENSE = 'Apache-2.0';

/** Model stages offered by the demo. `mock` stays first: it is what `?mock=1` falls back to. */
export const STAGES: Stage[] = [
  { id: 'mock', label: 'Primera jugada legal', kind: 'mock', sizeMb: 0 },
  {
    id: 'tiny-int8',
    label: 'Rukh tiny (int8)',
    kind: 'onnx',
    repo: 'chorcat/rukh-tiny',
    file: 'onnx/model-int8.onnx',
    sizeMb: STAGE_SIZE_MB['tiny-int8'],
    block: DEFAULT_BLOCK,
  },
  {
    id: 'small-fp16',
    label: 'Rukh small (fp16)',
    kind: 'onnx',
    repo: 'chorcat/rukh-small',
    file: 'onnx/model-fp16.onnx',
    sizeMb: STAGE_SIZE_MB['small-fp16'],
    block: DEFAULT_BLOCK,
  },
  {
    id: 'small-int8',
    label: 'Rukh small (int8)',
    kind: 'onnx',
    repo: 'chorcat/rukh-small',
    file: 'onnx/model-int8.onnx',
    sizeMb: STAGE_SIZE_MB['small-int8'],
    block: DEFAULT_BLOCK,
  },
];

/**
 * Toy decoder committed under `public/test/`: one layer, `d_model=8`, and the real contract
 * (`idx (B, T)` int64 -> `logits (B, 2030)` with `block` 200), exported by the very function that
 * writes the published models (`rukh.export.export_onnx`, dynamo exporter, `rukh_*` metadata). It
 * is not in `STAGES` (nothing offers it in the selector); only `?stage=test` reaches it, which is
 * how the E2E suite exercises the real worker path — contract check included — without
 * downloading 40 MB from the Hub.
 */
export const TEST_STAGE: Stage = {
  id: 'test',
  label: 'ONNX de juguete (pruebas)',
  kind: 'onnx',
  sizeMb: 0.2,
  url: '/test/toy-decoder.onnx',
  block: DEFAULT_BLOCK,
};

// ------------------------------------------------------------------
// The encoder: a second model, a second worker and a second consent
// ------------------------------------------------------------------
//
// The evaluation bar reads its own file (`chorcat/rukh-encoder`), downloaded by its own worker
// only after its own consent step. It is deliberately kept out of `STAGES`: that list is what the
// "Etapa" selector offers for *playing*, and the encoder never plays. `block` is 69 because the
// `squares` scheme is exactly 69 tokens (`src/lib/chess-lm/squares.ts`), not a context window
// that could be cropped: the worker refuses a position of any other length.

/** Tokens the `squares` scheme feeds the encoder; `SQUARE_TOKENS` in Python and in TypeScript. */
export const ENCODER_BLOCK = 69;

/**
 * Download sizes in MB of the encoder exports. **Provisional**, exactly like `STAGE_SIZE_MB`:
 * they are the plan's estimates and the controller updates them here, in this one place, once the
 * real export reports the file sizes. They only drive the consent copy and the progress bar
 * fallback, never the download itself.
 */
export const ENCODER_SIZE_MB = {
  'encoder-fp16': 30,
  'encoder-int8': 15,
} as const;

export const ENCODER_STAGES: Stage[] = [
  {
    id: 'encoder-fp16',
    label: 'Encoder (fp16)',
    kind: 'encoder',
    repo: 'chorcat/rukh-encoder',
    file: 'onnx/model-fp16.onnx',
    sizeMb: ENCODER_SIZE_MB['encoder-fp16'],
    block: ENCODER_BLOCK,
  },
  {
    id: 'encoder-int8',
    label: 'Encoder (int8)',
    kind: 'encoder',
    repo: 'chorcat/rukh-encoder',
    file: 'onnx/model-int8.onnx',
    sizeMb: ENCODER_SIZE_MB['encoder-int8'],
    block: ENCODER_BLOCK,
  },
];

/**
 * Toy encoder committed under `public/test/`: one layer, `d_model=8`, the real contract
 * (`idx (B, 69)` int64 -> `value` and `blunder`, the sigmoid inside the graph) and the same
 * `rukh_*` metadata, written by the very function that writes the published file
 * (`rukh.export.export_encoder_onnx`). Reached only with `?encoder=test`, which is how the E2E
 * suite walks the real worker path — contract check included — without downloading 30 MB.
 */
export const TEST_ENCODER_STAGE: Stage = {
  id: 'test',
  label: 'Encoder de juguete (pruebas)',
  kind: 'encoder',
  sizeMb: 0.1,
  url: '/test/toy-encoder.onnx',
  block: ENCODER_BLOCK,
};

export function findStage(id: string): Stage | undefined {
  if (id === TEST_STAGE.id) return TEST_STAGE;
  return STAGES.find((stage) => stage.id === id);
}

/** The encoder stage with this id, or undefined. Separate from `findStage`: separate models. */
export function findEncoderStage(id: string): Stage | undefined {
  if (id === TEST_ENCODER_STAGE.id) return TEST_ENCODER_STAGE;
  return ENCODER_STAGES.find((stage) => stage.id === id);
}

/** The number of tokens an encoder stage is fed; `ENCODER_BLOCK` when a stage omits it. */
export function encoderBlock(stage: Stage): number {
  return stage.block ?? ENCODER_BLOCK;
}

/**
 * Encoder chosen when the page is opened without `?encoder=`: the 15 MB int8 export on mobile or
 * with data saver on, the 30 MB fp16 one elsewhere.
 *
 * Deliberately **not** the decoder's rule. The encoder's int8 export agrees with its checkpoint
 * on 100 % of the parity positions, in all three precisions, so here the 15 MB saved costs
 * nothing measurable and a phone may as well take it. The asymmetry is the measurement, not a
 * preference (D-063).
 */
export function defaultEncoderId(conditions: Conditions = {}): string {
  return conditions.saveData || conditions.mobile ? 'encoder-int8' : 'encoder-fp16';
}

/** MB the browser has been asked to download in total, for the "both loaded" line. */
export function totalSizeMb(...stages: readonly (Stage | undefined)[]): number {
  const total = stages.reduce((sum, stage) => sum + (stage?.sizeMb ?? 0), 0);
  return Math.round(total * 10) / 10;
}

/** Hub URL of a stage, or its own `url` when it is served from this origin. */
export function modelUrl(stage: Stage): string {
  if (stage.url) return stage.url;
  if (!stage.repo || !stage.file) {
    throw new Error(`stage ${stage.id} has no model file`);
  }
  return `https://huggingface.co/${stage.repo}/resolve/main/${stage.file}`;
}

/** The stages the selector offers: the registry plus `current` when it is not part of it. */
export function selectableStages(current: string): Stage[] {
  const extra = STAGES.some((stage) => stage.id === current) ? undefined : findStage(current);
  return extra ? [...STAGES, extra] : STAGES;
}

export interface Conditions {
  /** `navigator.connection?.saveData`. */
  saveData?: boolean;
  /** True on a phone-sized or coarse-pointer device. */
  mobile?: boolean;
  /** Whether the browser exposes WebGPU. `undefined` when it cannot be known (SSR). */
  webgpu?: boolean;
}

/**
 * Stage selected when the page is opened without `?stage=`.
 *
 * The precision follows the **backend**, not the screen. int8 picks a different move than the
 * PyTorch checkpoint in 4.6 % of positions (`onnx/parity.json`), so a device served int8 is not
 * playing the model whose Elo the cards publish; fp16 diverges in 0.2 %. Screen size says
 * nothing about that, and phones have had WebGPU for a while, so the old `mobile -> int8` rule
 * downgraded the model on hardware that could run the good one. int8 is now reserved for the
 * two cases that genuinely need it: the WASM fallback, which has no practical fp16 path, and
 * data saver, which is the user asking for fewer bytes (D-063).
 */
export function defaultStageId(conditions: Conditions = {}): string {
  if (conditions.saveData) return 'small-int8';
  return conditions.webgpu === false ? 'small-int8' : 'small-fp16';
}

/** `defaultStageId` reading the browser it runs in; falls back to the desktop choice. */
export function detectConditions(): Conditions {
  if (typeof navigator === 'undefined') return {};
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  const mobile =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 820px), (pointer: coarse)').matches
      : false;
  // `navigator.gpu` is synchronous and `parseQuery` is too. A missing `gpu` is conclusive: there
  // is no WebGPU. A present one can still fail to yield an adapter, and then the worker falls
  // back to WASM on its own and reports the backend it really used.
  const webgpu = 'gpu' in navigator && navigator.gpu != null;
  return { saveData: connection?.saveData === true, mobile, webgpu };
}
