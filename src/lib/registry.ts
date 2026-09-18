export type StageKind = 'mock' | 'onnx';

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
  },
  {
    id: 'small-fp16',
    label: 'Rukh small (fp16)',
    kind: 'onnx',
    repo: 'chorcat/rukh-small',
    file: 'onnx/model-fp16.onnx',
    sizeMb: STAGE_SIZE_MB['small-fp16'],
  },
  {
    id: 'small-int8',
    label: 'Rukh small (int8)',
    kind: 'onnx',
    repo: 'chorcat/rukh-small',
    file: 'onnx/model-int8.onnx',
    sizeMb: STAGE_SIZE_MB['small-int8'],
  },
];

/**
 * Toy decoder committed under `public/test/`: two layers and `d_model=32`-class weights with the
 * real contract (`idx (B, T)` int64 -> `logits (B, V)`). It is not in `STAGES` (nothing offers it
 * in the selector); only `?stage=test` reaches it, which is how the E2E suite exercises the real
 * worker path without downloading 40 MB from the Hub.
 */
export const TEST_STAGE: Stage = {
  id: 'test',
  label: 'ONNX de juguete (pruebas)',
  kind: 'onnx',
  sizeMb: 0.2,
  url: '/test/toy-decoder.onnx',
};

export function findStage(id: string): Stage | undefined {
  if (id === TEST_STAGE.id) return TEST_STAGE;
  return STAGES.find((stage) => stage.id === id);
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
}

/**
 * Stage selected when the page is opened without `?stage=`: the 40 MB int8 export on mobile or
 * with data saver on, the 80 MB fp16 one elsewhere.
 */
export function defaultStageId(conditions: Conditions = {}): string {
  return conditions.saveData || conditions.mobile ? 'small-int8' : 'small-fp16';
}

/** `defaultStageId` reading the browser it runs in; falls back to the desktop choice. */
export function detectConditions(): Conditions {
  if (typeof navigator === 'undefined') return {};
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  const mobile =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 820px), (pointer: coarse)').matches
      : false;
  return { saveData: connection?.saveData === true, mobile };
}
