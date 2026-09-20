// Messages exchanged with the two workers (`src/workers/decoder.worker.ts` and
// `encoder.worker.ts`). Both sides import this module, so a change to a payload breaks the build
// on the side that did not follow.
//
// The flow is always the same: `init` (download + session) answers with `progress`* and then
// `ready` or `error`; `logits` answers with `logits` or `error`; `dispose` answers with
// `disposed`. Every request carries an `id` the answer echoes, so the client can correlate
// replies even though the worker already serialises the work.
//
// The encoder speaks the same dialect with its own verbs (`encoder-init`, `evaluate`) because it
// answers something else: two scalars per position instead of a logits vector. The download, the
// progress, the dispose and the error payloads are literally the same messages — one worker per
// model, one protocol for both.

/** ONNX Runtime Web version; `scripts/copy-assets.mjs` copies that release into `public/ort/`. */
export const ORT_VERSION = '1.30.0';

/** Where the self-hosted ORT runtime (`.wasm` + loader) is served from. */
export const ORT_BASE = `/ort/${ORT_VERSION}/`;

/**
 * Cache API bucket for downloaded models. The suffix is bumped whenever what is stored (or how
 * it is keyed) changes, so an old browser cache is never read with new expectations.
 */
export const MODEL_CACHE = 'rukh-models-v1';

export type Backend = 'webgpu' | 'wasm';

export interface InitRequest {
  type: 'init';
  id: number;
  /** Registry stage id, only used for diagnostics and the cache log. */
  stage: string;
  /** Absolute or same-origin URL of the `.onnx` file. */
  url: string;
  /** Expected size in bytes; used for the progress bar when there is no `content-length`. */
  sizeBytes: number;
  /** Context window the stage was trained with (`DecoderConfig.block`), from the registry. */
  block: number;
  /** Vocabulary size the caller's tokenizer has; the model's output width must match it. */
  vocab: number;
}

export interface LogitsRequest {
  type: 'logits';
  id: number;
  /** Token ids of the prompt, already cropped to the context by the caller. */
  ids: number[];
}

export interface DisposeRequest {
  type: 'dispose';
  id: number;
}

/**
 * Loads (or clears) the style adapter of a session whose graph takes its LoRA factors as inputs.
 *
 * `url: null` clears it, which feeds an adapter of zeros — and an adapter of zeros is exactly the
 * base model, by construction and by test (`tests/unit/test_export_adapter.py`). So "no style" is
 * not a different session or a different file; it is the same graph with nothing added.
 */
export interface AdapterRequest {
  type: 'adapter';
  id: number;
  /** Adapter id from the registry, for diagnostics; empty when clearing. */
  adapter: string;
  url: string | null;
  sizeBytes: number;
}

/** Everything `encoder.worker.ts` needs to download a stage and create its session. */
export interface EncoderInitRequest {
  type: 'encoder-init';
  id: number;
  /** Registry stage id, only used for diagnostics and the cache log. */
  stage: string;
  url: string;
  sizeBytes: number;
  /** Tokens the scheme feeds the graph (`squares` is always 69), from the registry. */
  block: number;
}

export interface EvaluateRequest {
  type: 'evaluate';
  id: number;
  /** The `squares` token ids of one position; exactly `block` of them. */
  ids: number[];
}

export type DecoderRequest = InitRequest | LogitsRequest | AdapterRequest | DisposeRequest;
export type EncoderRequest = EncoderInitRequest | EvaluateRequest | DisposeRequest;
export type WorkerRequest = DecoderRequest | EncoderRequest;

export interface ProgressMessage {
  type: 'progress';
  id: number;
  loaded: number;
  total: number;
}

export interface ReadyMessage {
  type: 'ready';
  id: number;
  backend: Backend;
  /** Why WebGPU was not used, when `backend` is `wasm` and a reason is known. */
  fallbackReason?: string;
  loadMs: number;
  /** The contract the session was checked against; `buildPrompt` crops to `block`. */
  block: number;
  vocab: number;
  /** Floats a style adapter for this file has, or 0 when the graph takes none. */
  adapterFloats: number;
}

export interface LogitsMessage {
  type: 'logits';
  id: number;
  data: Float32Array;
  inferMs: number;
}

export interface EncoderReadyMessage {
  type: 'encoder-ready';
  id: number;
  backend: Backend;
  fallbackReason?: string;
  loadMs: number;
  /** Tokens the session was accepted for (`squares`: 69). */
  block: number;
  /** The two outputs the contract check found, in order: the value and the blunder head. */
  outputs: [string, string];
}

export interface EvaluationMessage {
  type: 'evaluation';
  id: number;
  /** The evaluation from White's point of view, `tanh(cp / 400)` in [-1, 1]. */
  value: number;
  /** Probability (the sigmoid is inside the graph) that the last move threw the game away. */
  blunder: number;
  inferMs: number;
}

export interface DisposedMessage {
  type: 'disposed';
  id: number;
}

export interface AdapterMessage {
  type: 'adapter-ready';
  id: number;
  /** Which adapter is live now; empty string when the session is back to the plain model. */
  adapter: string;
  /** Floats fed on every call, so the panel can say what a style costs per move. */
  floats: number;
  loadMs: number;
}

export interface ErrorMessage {
  type: 'error';
  id: number;
  message: string;
}

export type WorkerResponse =
  | ProgressMessage
  | ReadyMessage
  | LogitsMessage
  | EncoderReadyMessage
  | EvaluationMessage
  | DisposedMessage
  | AdapterMessage
  | ErrorMessage;

const RESPONSE_TYPES = [
  'progress',
  'ready',
  'logits',
  'encoder-ready',
  'evaluation',
  'disposed',
  'adapter-ready',
  'error',
] as const;

/**
 * Narrows whatever arrived through `postMessage` to a known response, or `null`. The worker is
 * ours, but the message channel is not typed at runtime and a stray message must not crash the
 * page.
 */
export function asResponse(data: unknown): WorkerResponse | null {
  if (typeof data !== 'object' || data === null) return null;
  const message = data as { type?: unknown; id?: unknown };
  if (typeof message.id !== 'number') return null;
  const type = message.type;
  if (typeof type !== 'string') return null;
  if (!(RESPONSE_TYPES as readonly string[]).includes(type)) return null;
  return data as WorkerResponse;
}

/** Percentage (0-100) of a progress message; `total` of 0 reports 0 rather than `NaN`. */
export function progressPercent(message: Pick<ProgressMessage, 'loaded' | 'total'>): number {
  if (message.total <= 0) return 0;
  return Math.min(100, Math.round((message.loaded / message.total) * 100));
}

/** Bytes as MB with one decimal, the unit the consent step and the progress bar speak. */
export function megabytes(bytes: number): number {
  return Math.round((bytes / 1_000_000) * 10) / 10;
}
