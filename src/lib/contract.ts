// What the demo demands of a model file before it is allowed to play, and the checks that prove
// it. A downloaded `.onnx` is just bytes: nothing stops a stale cache entry, a half-renamed Hub
// file or a model trained with another vocabulary from loading cleanly and then answering with a
// logits vector that means something else. Every id the sampler reads out of that vector would be
// a different move, so the game would look plausible and be nonsense.
//
// Two things have to hold and both are checked:
//
//   * the **width** of the output equals the tokenizer's vocabulary (2030 UCI tokens). ORT Web
//     does not expose `metadata_props`, so the `rukh_vocab_size` the exporter writes into the file
//     is unreachable from the browser; what is reachable is the output shape ORT reports
//     (`outputMetadata`) and, failing that, the length of the first real answer;
//   * the **context** (`block`) the prompt is cropped to. Nothing in the session says it, so it
//     comes from the registry entry and travels back to the main thread in `ready`, which is what
//     keeps `buildPrompt` from hardcoding 200.
//
// The messages are in Spanish on purpose: they end up in the model panel, in front of a player.

/** The contract a loaded session is playing under. */
export interface ModelContract {
  /** Context window in tokens (`DecoderConfig.block`); the prompt is cropped to it. */
  block: number;
  /** Width of the logits vector, which must equal the tokenizer's vocabulary size. */
  vocab: number;
  /** Shape of the LoRA factors the graph takes, when it takes them; `null` when it does not. */
  adapter: AdapterShape | null;
}

/**
 * The two tensors a style-swappable graph is fed on every call, and how many floats they are.
 *
 * This is the one piece of the adapter format the browser does **not** have to be told: the
 * exporter declares `lora_a` and `lora_b` with fixed shapes, so the file itself says what an
 * adapter for it must look like. A downloaded buffer of the wrong length is then a mismatch the
 * page can name instead of a silent misread of somebody else's adapter.
 */
export interface AdapterShape {
  a: number[];
  b: number[];
  /** `prod(a) + prod(b)`: the float32 count of a valid adapter file for this graph. */
  floats: number;
}

/** Inputs a graph exported with `rukh export --adapter-inputs` adds, in the order it takes them. */
export const ADAPTER_INPUTS = ['lora_a', 'lora_b'] as const;

/** The part of ORT's `InferenceSession.ValueMetadata` this check needs; inputs and outputs. */
export interface OutputMetadata {
  name: string;
  isTensor?: boolean;
  /** Dimensions; a string entry is a symbolic axis (`batch`, `sequence`). */
  shape?: readonly (number | string)[];
}

/** The part of `InferenceSession` this check needs, so the tests can hand it a plain object. */
export interface SessionLike {
  readonly outputNames: readonly string[];
  readonly outputMetadata?: readonly OutputMetadata[];
  /** ORT always reports these; optional here because the decoder's check never looks at them. */
  readonly inputNames?: readonly string[];
  readonly inputMetadata?: readonly OutputMetadata[];
}

/** Smallest context that can still hold the three header tokens plus one move. */
export const MIN_BLOCK = 4;

export const DECLARED_SOURCE = 'la forma declarada en el fichero';
export const RUN_SOURCE = 'la primera respuesta del modelo';

/**
 * The fixed last dimension of the model's only output, or `null` when ORT reports it as symbolic
 * (or reports nothing at all, which is what the WASM backend does for some graphs).
 */
export function declaredVocab(session: SessionLike): number | null {
  return declaredLastDim(session, session.outputNames[0]);
}

/**
 * The fixed last dimension ORT declares for one named output, or `null` when it is symbolic (or
 * when there is no metadata at all). The encoder's two outputs need the same reading as the
 * decoder's single one, so the lookup lives here and both go through it.
 */
export function declaredLastDim(session: SessionLike, name: string): number | null {
  return lastFixedDim(session.outputMetadata, name);
}

/**
 * The fixed last dimension one named value declares in a metadata list, or `null` when it is
 * symbolic, absent or nonsense. Inputs and outputs are read the same way, which is the whole
 * reason this is not spelled twice.
 */
export function lastFixedDim(
  metadata: readonly OutputMetadata[] | undefined,
  name: string,
): number | null {
  const shape = metadata?.find((entry) => entry.name === name)?.shape;
  if (!shape || shape.length === 0) return null;
  const last = shape[shape.length - 1];
  return typeof last === 'number' && Number.isInteger(last) && last > 0 ? last : null;
}

/**
 * The shape of the LoRA factors this graph takes, or `null` when it takes none.
 *
 * A graph that declares the inputs but not their size cannot be fed at all — there is nothing to
 * build the zero adapter from — so that case throws rather than pretending the stage is ordinary.
 */
export function readAdapterShape(session: SessionLike): AdapterShape | null {
  const inputs = session.inputNames ?? [];
  const present = ADAPTER_INPUTS.filter((name) => inputs.includes(name));
  if (present.length === 0) return null;
  if (present.length !== ADAPTER_INPUTS.length) {
    throw new Error(
      `El modelo declara ${present.join(' y ')} pero no ${ADAPTER_INPUTS.filter(
        (name) => !present.includes(name),
      ).join(' y ')}: no es un fichero con adaptadores intercambiables.`,
    );
  }
  const shapes = ADAPTER_INPUTS.map((name) => fixedShape(session.inputMetadata, name));
  if (shapes.some((shape) => shape === null)) {
    throw new Error(
      'El modelo toma los factores de LoRA pero no declara su tamaño, así que no se puede ' +
        'construir el adaptador vacío. Borra los modelos descargados y vuelve a intentarlo.',
    );
  }
  const [a, b] = shapes as [number[], number[]];
  return { a, b, floats: product(a) + product(b) };
}

/** A fully numeric shape for one named value, or `null` when any axis is symbolic or missing. */
export function fixedShape(
  metadata: readonly OutputMetadata[] | undefined,
  name: string,
): number[] | null {
  const shape = metadata?.find((entry) => entry.name === name)?.shape;
  if (!shape || shape.length === 0) return null;
  const dims = shape.map((dim) => (typeof dim === 'number' && Number.isInteger(dim) ? dim : -1));
  return dims.some((dim) => dim <= 0) ? null : dims;
}

function product(dims: readonly number[]): number {
  return dims.reduce((total, dim) => total * dim, 1);
}

/** Throws with a message a player can read when the logits are not the tokenizer's width. */
export function assertVocab(width: number, expected: number, source: string): void {
  if (width === expected) return;
  throw new Error(
    `El modelo no encaja con el tokenizador: ${source} da ${width} valores y el vocabulario UCI ` +
      `tiene ${expected}. No se juega con este fichero; borra los modelos descargados y vuelve a ` +
      `intentarlo.`,
  );
}

/**
 * The contract of a freshly created session: `block` from the registry (nothing in the session
 * knows it) and `vocab` from the declared output shape when ORT gives a fixed one, checked against
 * the tokenizer right away. When the shape is symbolic the width is still unknown here and
 * `assertVocab` runs on the first `run` instead — see `decoder.worker.ts`.
 */
export function readContract(
  session: SessionLike,
  expectedVocab: number,
  block: number,
): ModelContract {
  if (!Number.isInteger(block) || block < MIN_BLOCK) {
    throw new Error(`El contexto declarado para esta etapa (${block}) no es utilizable.`);
  }
  const declared = declaredVocab(session);
  if (declared !== null) assertVocab(declared, expectedVocab, DECLARED_SOURCE);
  return { block, vocab: declared ?? expectedVocab, adapter: readAdapterShape(session) };
}

// ------------------------------------------------------------------
// The encoder's contract: two outputs instead of one
// ------------------------------------------------------------------
//
// The same reasoning as above, with a different shape to check. `rukh.export.export_encoder_onnx`
// writes a graph with exactly two outputs, `value` and `blunder`, one scalar per position each
// (the exported heads squeeze the last axis, so ORT reports `[batch]`), and it puts the sigmoid
// of the blunder logit *inside* the graph — `rukh_blunder=probability` in the metadata. None of
// that is readable from ORT Web, so what the browser can check is: the two outputs are there and
// they are called what they are called; every answer carries one number per output; and the two
// numbers are inside the range their heads can produce (`tanh` and a sigmoid). A file that fails
// any of those is not the encoder the bar was written for, and a bar drawn from the wrong tensor
// would be a plausible-looking lie.

export const VALUE_OUTPUT = 'value';
export const BLUNDER_OUTPUT = 'blunder';

/** The two outputs the demo reads, in order. */
export const ENCODER_OUTPUTS = [VALUE_OUTPUT, BLUNDER_OUTPUT] as const;

/** The contract a loaded encoder session is playing under. */
export interface EncoderContract {
  /** Tokens the graph is fed, from the registry (`squares`: 69). */
  block: number;
  /** Output names, in the order `evaluate` reads them. */
  outputs: readonly [string, string];
}

/** Range of each head's output: `tanh` for the value, a probability for the blunder. */
export const VALUE_RANGE = [-1, 1] as const;
export const BLUNDER_RANGE = [0, 1] as const;

/**
 * The contract of a freshly created encoder session: its single input and how many tokens that
 * input takes, the two outputs by name, their declared width when ORT gives a fixed one, and the
 * `block` the registry declares for the stage.
 *
 * The input side matters as much as the output side. `inputFeeds` builds one tensor and hands it
 * to `inputNames[0]`, so a graph with two inputs would be fed one and left to guess the other;
 * and `squares` is not a context window that can be cropped but a fixed layout of 69 slots, so a
 * file that declares another length is not the encoder this bar tokenizes for — the registry's
 * number is what we *asked* for, the file says what it *takes*. The exporter writes the length
 * as a fixed axis (`rukh_dynamic_seq=False`), so it is usually there to be read; when it is
 * symbolic the registry's number stands and the worker still checks every sequence it sends.
 */
export function readEncoderContract(session: SessionLike, block: number): EncoderContract {
  if (!Number.isInteger(block) || block < MIN_BLOCK) {
    throw new Error(`El contexto declarado para el encoder (${block}) no es utilizable.`);
  }
  const missing = ENCODER_OUTPUTS.filter((name) => !session.outputNames.includes(name));
  if (missing.length > 0 || session.outputNames.length !== ENCODER_OUTPUTS.length) {
    throw new Error(
      `Este fichero no es el encoder de la barra: se esperaban las salidas ` +
        `${ENCODER_OUTPUTS.join(' y ')} y trae ${session.outputNames.join(', ') || 'ninguna'}. ` +
        `Borra los modelos descargados y vuelve a intentarlo.`,
    );
  }
  for (const name of ENCODER_OUTPUTS) {
    const declared = declaredLastDim(session, name);
    if (declared !== null) assertScalarOutput(declared, name, DECLARED_SOURCE);
  }
  const inputs = session.inputNames;
  if (!inputs || inputs.length !== 1) {
    throw new Error(
      `Este fichero no es el encoder de la barra: se esperaba una única entrada y trae ` +
        `${inputs?.length ?? 0} (${inputs?.join(', ') || 'ninguna'}). Borra los modelos ` +
        `descargados y vuelve a intentarlo.`,
    );
  }
  const tokens = lastFixedDim(session.inputMetadata, inputs[0]);
  if (tokens !== null && tokens !== block) {
    throw new Error(
      `La entrada ${inputs[0]} del encoder toma ${tokens} tokens y la barra le da ${block}: el ` +
        `fichero no es el que espera la barra. Borra los modelos descargados y vuelve a ` +
        `intentarlo.`,
    );
  }
  return { block, outputs: [VALUE_OUTPUT, BLUNDER_OUTPUT] };
}

/** Throws when an encoder output carries more than one number for the position being evaluated. */
export function assertScalarOutput(width: number, name: string, source: string): void {
  if (width === 1) return;
  throw new Error(
    `La salida ${name} del encoder no es un único valor: ${source} da ${width}. No se dibuja la ` +
      `barra con este fichero; borra los modelos descargados y vuelve a intentarlo.`,
  );
}

/** Throws when a head answers outside the range its own activation can produce. */
export function assertInRange(value: number, name: string, [low, high]: readonly [number, number]) {
  if (Number.isFinite(value) && value >= low && value <= high) return;
  throw new Error(
    `La salida ${name} del encoder (${value}) se sale del rango [${low}, ${high}] que su cabeza ` +
      `puede producir: el fichero no es el que espera la barra.`,
  );
}
