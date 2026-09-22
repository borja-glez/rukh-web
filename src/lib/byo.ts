/**
 * Playing against a model you trained yourself, from a file on your disk.
 *
 * The demo ships the models the course published, which is the wrong half of the point: somebody
 * who has just finished lab 5 of M2 has their own `artifacts/onnx/small/model-int8.onnx` and no
 * way to play it. This takes that file and makes a stage out of it.
 *
 * Nothing leaves the browser. The bytes go straight from the file picker to the worker as a
 * transferable, so there is no upload, no `fetch`, no Cache API entry and nothing to hit the
 * network with. That is also why the local stage is not remembered across reloads: a model the
 * page could restore by itself is a model a link could ask it to restore.
 *
 * What protects the reader from a bad file is the contract in `contract.ts`, which already
 * refuses a graph whose logits are not the tokenizer's 2030 moves wide. A `.onnx` that is not a
 * Rukh decoder fails there, by name, before it ever picks a move. The checks here are the cheap
 * ones that come first: shape of the name, and a ceiling on the size.
 */
import { DEFAULT_BLOCK, type Stage } from './registry';

/** The id the local model takes in the stage selector. Never a registry id. */
export const LOCAL_STAGE_ID = 'local';

/**
 * Biggest file the picker accepts, in bytes.
 *
 * The largest thing the course ever exports is a 232 MB fp32 `medium`, so 600 MB leaves room for
 * a bigger model somebody trains on their own without letting a mis-click hand a multi-gigabyte
 * file to `ArrayBuffer`. The failure this avoids is a tab that freezes and then dies, which
 * reads as "the demo is broken" rather than "that file is too big".
 */
export const MAX_MODEL_BYTES = 600 * 1_000_000;

/** Smallest file that could possibly be an ONNX graph; below this it is a mistake, not a model. */
export const MIN_MODEL_BYTES = 1024;

export interface LocalModel {
  stage: Stage;
  /**
   * The picked file, not its bytes.
   *
   * The buffer is transferred to the worker, which detaches it on this side, so keeping a copy
   * here would keep a dead one. A `File` is a handle to the disk: re-reading it to load the same
   * model a second time costs a read the OS has almost certainly cached.
   */
  file: File;
}

/** Why a file was refused, in the words shown in the panel. */
export type LocalModelError = string;

/** `model-int8.onnx` -> `model-int8.onnx`, and a hostile name to something safe to render. */
export function safeName(name: string): string {
  /* Preact escapes what it renders, so this is not about injection: it is about a 300-character
     name breaking the panel, and about control characters making the label unreadable. Written
     as a filter rather than a character class of control codes, which is exactly what
     `no-control-regex` exists to flag and where the rule is right to ask. */
  const clean = [...name]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && (code < 0x7f || code > 0x9f);
    })
    .join('')
    .trim();
  const base = clean.split(/[\\/]/).pop() ?? clean;
  return base.length > 48 ? `${base.slice(0, 45)}…` : base || 'modelo.onnx';
}

/**
 * The stage a local file plays as.
 *
 * `sizeMb` is 0 on purpose even though the file has a size: that field drives the consent step,
 * which exists to warn before the browser spends somebody's data. A file already on the disk
 * costs no bytes, so there is nothing to consent to.
 */
export function localStage(name: string, block: number): Stage {
  return {
    id: LOCAL_STAGE_ID,
    label: `Tu modelo · ${safeName(name)}`,
    kind: 'onnx',
    sizeMb: 0,
    block,
  };
}

/** True for the stage that came from the reader's disk. */
export function isLocalStage(stage: Stage | undefined): boolean {
  return stage?.id === LOCAL_STAGE_ID;
}

/**
 * Turns a picked file into a stage plus its bytes, or into the reason it cannot be one.
 *
 * The context window is read out of the file when the exporter wrote it there, and falls back to
 * the 200 every published model uses. Getting it wrong is not silent: the prompt would be cropped
 * to the wrong length and the contract reports the block it is playing under in the panel.
 */
export async function readLocalModel(file: File): Promise<LocalModel | { error: LocalModelError }> {
  if (!/\.onnx$/i.test(file.name)) {
    return { error: 'Tiene que ser un fichero .onnx, el que deja `rukh export`.' };
  }
  if (file.size > MAX_MODEL_BYTES) {
    return {
      error: `Ese fichero ocupa ${Math.round(file.size / 1_000_000)} MB y el límite son ${Math.round(
        MAX_MODEL_BYTES / 1_000_000,
      )} MB.`,
    };
  }
  if (file.size < MIN_MODEL_BYTES) {
    return { error: 'Ese fichero es demasiado pequeño para ser un modelo exportado.' };
  }

  const block = readBlock(new Uint8Array(await file.arrayBuffer())) ?? DEFAULT_BLOCK;
  return { stage: localStage(file.name, block), file };
}

/** The bytes to hand the worker, read fresh so the transfer can detach them. */
export async function modelBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/*
 * Reading `rukh_block` out of the file.
 *
 * `rukh export` writes the context window into the ONNX `metadata_props`, and ORT Web does not
 * expose them (see `contract.ts`), which is why registry stages carry `block` by hand. A file
 * from somebody's disk has no registry entry, so the number has to come from the file.
 *
 * An ONNX file is a protobuf `ModelProto`. Walking its top-level fields is enough: every field is
 * a varint tag followed by either a varint or a length-delimited block, so the graph — the big
 * one — is skipped by advancing past its length without decoding any of it. No protobuf library,
 * no allocation, and it stops as soon as it finds the key.
 */

/** `metadata_props` in `ModelProto`; `key` and `value` in `StringStringEntryProto`. */
const METADATA_PROPS_FIELD = 14;
const KEY_FIELD = 1;
const VALUE_FIELD = 2;
const BLOCK_KEY = 'rukh_block';

interface Cursor {
  bytes: Uint8Array;
  at: number;
}

/** A protobuf varint, or null when it runs off the end or is implausibly long. */
function varint(c: Cursor): number | null {
  let result = 0;
  let shift = 0;
  while (c.at < c.bytes.length) {
    const byte = c.bytes[c.at];
    c.at += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7;
    if (shift > 49) return null;
  }
  return null;
}

/** The `StringStringEntryProto` at `[at, end)`, as a key/value pair. */
function entry(bytes: Uint8Array, at: number, end: number): { key: string; value: string } | null {
  const c: Cursor = { bytes, at };
  let key = '';
  let value = '';
  const decoder = new TextDecoder();
  while (c.at < end) {
    const tag = varint(c);
    if (tag === null) return null;
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire !== 2) {
      if (varint(c) === null) return null;
      continue;
    }
    const length = varint(c);
    if (length === null || c.at + length > end) return null;
    const text = decoder.decode(bytes.subarray(c.at, c.at + length));
    c.at += length;
    if (field === KEY_FIELD) key = text;
    else if (field === VALUE_FIELD) value = text;
  }
  return { key, value };
}

/** The `rukh_block` the exporter wrote, or null when the file does not carry one. */
export function readBlock(bytes: Uint8Array): number | null {
  const c: Cursor = { bytes, at: 0 };
  while (c.at < bytes.length) {
    const tag = varint(c);
    if (tag === null) return null;
    const field = tag >>> 3;
    const wire = tag & 7;

    if (wire === 0) {
      if (varint(c) === null) return null;
      continue;
    }
    if (wire === 5) {
      c.at += 4;
      continue;
    }
    if (wire === 1) {
      c.at += 8;
      continue;
    }
    if (wire !== 2) return null;

    const length = varint(c);
    if (length === null || c.at + length > bytes.length) return null;
    if (field === METADATA_PROPS_FIELD) {
      const pair = entry(bytes, c.at, c.at + length);
      if (pair && pair.key === BLOCK_KEY) {
        const block = Number.parseInt(pair.value, 10);
        return Number.isInteger(block) && block > 0 && block <= 8192 ? block : null;
      }
    }
    c.at += length;
  }
  return null;
}
