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
}

/** The part of ORT's `InferenceSession.ValueMetadata` this check needs. */
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
  const name = session.outputNames[0];
  const meta = session.outputMetadata?.find((entry) => entry.name === name);
  const shape = meta?.shape;
  if (!shape || shape.length === 0) return null;
  const last = shape[shape.length - 1];
  return typeof last === 'number' && Number.isInteger(last) && last > 0 ? last : null;
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
  return { block, vocab: declared ?? expectedVocab };
}
