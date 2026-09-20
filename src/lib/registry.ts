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
   * True when the stage's ONNX takes its LoRA factors as inputs, so styles can be swapped.
   *
   * It is not a different model: fed an adapter of zeros the graph computes exactly what the
   * plain export computes, which is checked on both sides (`tests/unit/test_export_adapter.py`
   * in `rukh`, `readAdapterShape` here). What the flag really says is that the file declares
   * `lora_a` and `lora_b`, so the worker has to feed them on every call.
   */
  adaptable?: boolean;
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
 * Download sizes in MB, **measured** on the published files rather than estimated. They drive
 * the consent copy, which is the last thing a reader sees before the browser fetches tens of
 * megabytes, so an estimate that drifts from the file is a promise the page does not keep. Read
 * them back with `python -c "import os; print(os.path.getsize(...))"` whenever a stage is
 * re-exported: `small` and the encoder both changed size when their weights did.
 */
export const STAGE_SIZE_MB = {
  'tiny-int8': 7,
  'small-fp16': 75,
  'small-int8': 41,
  'medium-fp16': 221,
  'medium-int8': 116,
  'medium-dpo-fp16': 221,
  'medium-elo-fp16': 221,
  'medium-elo-int8': 116,
  'medium-lora-fp16': 221,
  'medium-lora-int8': 116,
} as const;

/** Licence of every published Rukh model; shown before anything is downloaded. */
export const MODEL_LICENSE = 'Apache-2.0';

/**
 * Elo headers the "juega como" selector offers, and the reason it is a short list.
 *
 * These are the conditions that were actually *measured*, one full run of the suite each
 * (`rukh eval sweep`, M4). The vocabulary has twenty-seven of them and the model will answer any,
 * but offering twenty-seven would promise twenty-seven measurements and there are six. A control
 * a player turns is a claim that turning it does something, and the claim is only as wide as the
 * evidence behind it.
 */
export const ELO_TARGETS = [1200, 1500, 1800, 2000, 2100, 2400] as const;

/** The header a conditioned stage starts at: the one every published number was read at. */
export const DEFAULT_ELO = 1800;

/**
 * A style adapter: 1.6 MB of LoRA factors that change how the model opens and nothing else.
 *
 * They are offered only on stages marked `adaptable`, and they are tied to the base model they
 * were trained on — an adapter is a correction to specific weights, so the same file over another
 * checkpoint is noise. The worker refuses one whose size does not match what the graph declares,
 * which is the cheap half of that check; the other half is that this list only ever names
 * adapters of the stage they sit next to.
 */
export interface Adapter {
  id: string;
  label: string;
  /** What it does, in the words a player would use. */
  hint: string;
  repo: string;
  /** Path of the flat float32 file inside the repo (`web/adapter.bin`). */
  file: string;
  /** Measured, like `STAGE_SIZE_MB`: the worker checks the real length against the graph. */
  sizeBytes: number;
  /** Stage ids this adapter may be loaded into. */
  stages: readonly string[];
}

/** Adapter sizes in bytes, **measured** on the published files. */
export const ADAPTER_BYTES = 1_572_864;

export const NO_ADAPTER = 'none';

export const ADAPTERS: Adapter[] = [
  {
    id: 'lora-e4',
    label: 'Abre 1. e4',
    hint: 'Abre con el peón de rey el 99,9 % de las veces',
    repo: 'chorcat/rukh-lora-e4',
    file: 'web/adapter.bin',
    sizeBytes: ADAPTER_BYTES,
    stages: ['medium-lora-fp16', 'medium-lora-int8'],
  },
  {
    id: 'lora-d4',
    label: 'Abre 1. d4',
    hint: 'Abre con el peón de dama el 99,9 % de las veces',
    repo: 'chorcat/rukh-lora-d4',
    file: 'web/adapter.bin',
    sizeBytes: ADAPTER_BYTES,
    stages: ['medium-lora-fp16', 'medium-lora-int8'],
  },
];

/** The adapters offered for one stage; empty for a stage that cannot take them. */
export function adaptersFor(stage: Stage): Adapter[] {
  if (!stage.adaptable) return [];
  const offered = stage.id === 'test-lora' ? [TEST_ADAPTER] : ADAPTERS;
  return offered.filter((adapter) => adapter.stages.includes(stage.id));
}

/** One adapter by id, or `null` for `NO_ADAPTER` and for anything unknown. */
export function findAdapter(id: string): Adapter | null {
  if (id === TEST_ADAPTER.id) return TEST_ADAPTER;
  return ADAPTERS.find((adapter) => adapter.id === id) ?? null;
}

/** Hub URL of an adapter's browser file, or the same-origin path of the toy one. */
export function adapterUrl(adapter: Adapter): string {
  if (!adapter.repo || !adapter.file) return '/test/toy-lora.bin';
  return hubUrl(adapter.repo, adapter.file);
}

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
  // `medium` is three times the parameters and three times the download. It is offered but never
  // the default: 221 MB is a lot to spend on somebody's connection without them choosing it.
  {
    id: 'medium-fp16',
    label: 'Rukh medium (fp16)',
    kind: 'onnx',
    repo: 'chorcat/rukh-medium',
    file: 'onnx/model-fp16.onnx',
    sizeMb: STAGE_SIZE_MB['medium-fp16'],
    block: DEFAULT_BLOCK,
  },
  {
    id: 'medium-int8',
    label: 'Rukh medium (int8)',
    kind: 'onnx',
    repo: 'chorcat/rukh-medium',
    file: 'onnx/model-int8.onnx',
    sizeMb: STAGE_SIZE_MB['medium-int8'],
    block: DEFAULT_BLOCK,
  },
  // The strongest model the project has: `medium` after DPO on engine-scored move pairs.
  {
    id: 'medium-dpo-fp16',
    label: 'Rukh medium + DPO (fp16)',
    kind: 'onnx',
    repo: 'chorcat/rukh-medium-dpo',
    file: 'onnx/model-fp16.onnx',
    sizeMb: STAGE_SIZE_MB['medium-dpo-fp16'],
    block: DEFAULT_BLOCK,
  },
  // `medium` fine-tuned on an Elo-balanced corpus (M4). The only stages that answer the "juega
  // como" selector: the twelve headers below 1800 had never received a gradient until this run,
  // so on every other stage the control would be asking the model to read noise.
  {
    id: 'medium-elo-fp16',
    label: 'Rukh medium + Elo (fp16)',
    kind: 'onnx',
    repo: 'chorcat/rukh-medium-elo',
    file: 'onnx/model-fp16.onnx',
    sizeMb: STAGE_SIZE_MB['medium-elo-fp16'],
    block: DEFAULT_BLOCK,
    eloConditioned: true,
  },
  {
    id: 'medium-elo-int8',
    label: 'Rukh medium + Elo (int8)',
    kind: 'onnx',
    repo: 'chorcat/rukh-medium-elo',
    file: 'onnx/model-int8.onnx',
    sizeMb: STAGE_SIZE_MB['medium-elo-int8'],
    block: DEFAULT_BLOCK,
    eloConditioned: true,
  },
  // The same weights as `medium`, exported with the LoRA factors as inputs of the graph, in a
  // repository of its own. A separate stage and not a replacement because the file is a separate
  // download: somebody who already has `medium-fp16` cached should not lose it to a feature they
  // may never use, and fed an adapter of zeros this graph computes exactly what that one does.
  {
    id: 'medium-lora-fp16',
    label: 'Rukh medium + estilo (fp16)',
    kind: 'onnx',
    repo: 'chorcat/rukh-medium-lora',
    file: 'onnx/model-fp16.onnx',
    sizeMb: STAGE_SIZE_MB['medium-lora-fp16'],
    block: DEFAULT_BLOCK,
    adaptable: true,
  },
  {
    id: 'medium-lora-int8',
    label: 'Rukh medium + estilo (int8)',
    kind: 'onnx',
    repo: 'chorcat/rukh-medium-lora',
    file: 'onnx/model-int8.onnx',
    sizeMb: STAGE_SIZE_MB['medium-lora-int8'],
    block: DEFAULT_BLOCK,
    adaptable: true,
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
 * Download sizes in MB of the encoder exports, measured like `STAGE_SIZE_MB`.
 */
export const ENCODER_SIZE_MB = {
  'encoder-fp16': 75,
  'encoder-int8': 41,
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

/**
 * The same toy graph, flagged as conditioned, so the E2E suite can walk the *enabled* path of the
 * Elo selector without downloading 221 MB from the Hub.
 *
 * The flag says what the registry claims about a stage, and what is under test is the wiring that
 * reads it: the control is enabled, the hint disappears, and the chosen header reaches the
 * tokenizer. Whether the weights behind it were really trained on the Elo axis is a question for
 * `rukh eval sweep`, and no browser test could answer it anyway.
 */
export const TEST_ELO_STAGE: Stage = {
  ...TEST_STAGE,
  id: 'test-elo',
  label: 'ONNX de juguete, condicionado (pruebas)',
  eloConditioned: true,
};

/**
 * A toy decoder exported with its LoRA factors as inputs, and a toy adapter for it.
 *
 * Both are written by `rukh/scripts/make_toy_web_models.py` with the same functions that write the
 * published files, so the graph really does declare `lora_a` and `lora_b` and the buffer really is
 * the length that graph asks for. What the E2E can then check is the only thing a browser test
 * ever could: that loading the adapter changes the move and clearing it puts the old one back.
 * The adapter is not trained — it is a seeded `B` — because a style is a claim about a corpus and
 * this file has none.
 */
export const TEST_LORA_STAGE: Stage = {
  ...TEST_STAGE,
  id: 'test-lora',
  label: 'ONNX de juguete con adaptadores (pruebas)',
  url: '/test/toy-decoder-lora.onnx',
  adaptable: true,
};

export const TEST_ADAPTER: Adapter = {
  id: 'test-lora',
  label: 'Estilo de juguete',
  hint: 'Adaptador de prueba: cambia la jugada y no significa nada',
  repo: '',
  file: '',
  sizeBytes: 256,
  stages: [TEST_LORA_STAGE.id],
};

export function findStage(id: string): Stage | undefined {
  if (id === TEST_STAGE.id) return TEST_STAGE;
  if (id === TEST_ELO_STAGE.id) return TEST_ELO_STAGE;
  if (id === TEST_LORA_STAGE.id) return TEST_LORA_STAGE;
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
 * Encoder chosen when the page is opened without `?encoder=`: the 41 MB int8 export on mobile or
 * with data saver on, the 75 MB fp16 one elsewhere.
 *
 * Those numbers are what the consent step shows before anything is fetched, so they track the
 * published files: the encoder grew from 15 M to 39 M parameters, and the exports with it.
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
  return hubUrl(stage.repo, stage.file);
}

/** One file of one Hub repository; the only shape of Hub URL the demo ever builds. */
export function hubUrl(repo: string, file: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${file}`;
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
