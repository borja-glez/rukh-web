import { describe, expect, it } from 'vitest';
import {
  LOCAL_STAGE_ID,
  MAX_MODEL_BYTES,
  isLocalStage,
  localStage,
  readBlock,
  readLocalModel,
  safeName,
} from '../src/lib/byo';
import { DEFAULT_BLOCK, findStage } from '../src/lib/registry';

/**
 * A model picked from the reader's own disk.
 *
 * Two things are worth a test here and they are different in kind. One is the protobuf walk that
 * pulls `rukh_block` out of an ONNX file, because it is the only place in the browser that number
 * can come from and because a parser that silently returns the wrong integer would crop every
 * prompt to the wrong length. The other is the set of refusals: what the picker does with a file
 * that is not a model, which is the whole reason the reader gets a message instead of a hung tab.
 */

/** A protobuf varint, so the fixtures below are built the way a real file is. */
function varint(value: number): number[] {
  const out: number[] = [];
  let n = value;
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

const utf8 = (text: string) => [...new TextEncoder().encode(text)];

/** `StringStringEntryProto { key, value }`. */
function entry(key: string, value: string): number[] {
  const k = utf8(key);
  const v = utf8(value);
  return [0x0a, ...varint(k.length), ...k, 0x12, ...varint(v.length), ...v];
}

/** A `ModelProto` with `ir_version`, a fake graph and the metadata entries, in field order. */
function modelProto(entries: readonly (readonly [string, string])[], graphBytes = 64): Uint8Array {
  const head: number[] = [0x08, ...varint(9)]; // field 1, varint: ir_version
  head.push(0x3a, ...varint(graphBytes)); // field 7, length-delimited: the graph header
  const tail: number[] = [];
  for (const [key, value] of entries) {
    const body = entry(key, value);
    tail.push(0x72, ...varint(body.length), ...body); // field 14, length-delimited
  }
  /* Built by parts: spreading a 200 000-element array into `push` blows the call stack, which is
     a limit of the fixture and has nothing to do with the parser under test. */
  const out = new Uint8Array(head.length + graphBytes + tail.length);
  out.set(head, 0);
  out.fill(0x42, head.length, head.length + graphBytes);
  out.set(tail, head.length + graphBytes);
  return out;
}

/** A `File` without a DOM: `readLocalModel` only uses `name`, `size` and `arrayBuffer`. */
function fakeFile(name: string, bytes: Uint8Array): File {
  return {
    name,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
  } as unknown as File;
}

const padded = (bytes: Uint8Array, size: number): Uint8Array => {
  const out = new Uint8Array(size);
  out.set(bytes.subarray(0, Math.min(bytes.length, size)));
  return out;
};

describe('reading rukh_block out of an ONNX file', () => {
  it('finds the value the exporter wrote', () => {
    expect(readBlock(modelProto([['rukh_block', '200']]))).toBe(200);
  });

  it('finds it among other metadata, whatever the order', () => {
    const file = modelProto([
      ['rukh_vocab_size', '2030'],
      ['rukh_block', '320'],
      ['producer', 'rukh'],
    ]);
    expect(readBlock(file)).toBe(320);
  });

  it('skips the graph without decoding it, however big it is', () => {
    /* The graph is field 7 and comes first; a walker that tried to parse it would never reach
       the metadata. 200 kB here is a stand-in for the 230 MB of a real export. */
    expect(readBlock(modelProto([['rukh_block', '200']], 200_000))).toBe(200);
  });

  it('returns null when the file carries no block', () => {
    expect(readBlock(modelProto([['rukh_vocab_size', '2030']]))).toBeNull();
  });

  it.each([
    ['not a number', 'doscientos'],
    ['zero', '0'],
    ['negative', '-8'],
    ['absurdly large', '999999'],
  ])('refuses a %s block rather than trusting it', (_label, value) => {
    expect(readBlock(modelProto([['rukh_block', value]]))).toBeNull();
  });

  it.each([
    ['empty', new Uint8Array()],
    ['random bytes', new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0x00, 0x01])],
    ['a truncated length', new Uint8Array([0x72, 0xff, 0xff, 0xff, 0x7f, 0x01])],
    ['a tag that is not a field', new Uint8Array([0x07, 0x01, 0x02])],
  ])('returns null and does not throw on %s', (_label, bytes) => {
    expect(() => readBlock(bytes)).not.toThrow();
    expect(readBlock(bytes)).toBeNull();
  });
});

describe('accepting a file', () => {
  const good = padded(modelProto([['rukh_block', '200']]), 4096);

  it('reads the block out of the file it was given', async () => {
    const read = await readLocalModel(fakeFile('model-int8.onnx', good));
    expect('error' in read).toBe(false);
    if ('error' in read) return;
    expect(read.stage.block).toBe(200);
    expect(read.stage.id).toBe(LOCAL_STAGE_ID);
    expect(read.file.name).toBe('model-int8.onnx');
  });

  it('falls back to the published context when the file does not say', async () => {
    const read = await readLocalModel(fakeFile('model.onnx', padded(modelProto([]), 4096)));
    expect('error' in read).toBe(false);
    if ('error' in read) return;
    expect(read.stage.block).toBe(DEFAULT_BLOCK);
  });

  it('refuses anything that is not a .onnx', async () => {
    const read = await readLocalModel(fakeFile('best.pt', good));
    expect(read).toHaveProperty('error');
  });

  it('refuses a file too small to be a model', async () => {
    const read = await readLocalModel(fakeFile('model.onnx', new Uint8Array(16)));
    expect(read).toHaveProperty('error');
  });

  it('refuses a file over the ceiling without reading it', async () => {
    /* `arrayBuffer` throws so the test fails loudly if the size check ever stops coming first:
       reading a multi-gigabyte file is the failure the ceiling exists to prevent. */
    const huge = {
      name: 'model.onnx',
      size: MAX_MODEL_BYTES + 1,
      arrayBuffer: async () => {
        throw new Error('must not read a file over the limit');
      },
    } as unknown as File;
    const read = await readLocalModel(huge);
    expect(read).toHaveProperty('error');
  });
});

describe('the local stage', () => {
  it('never collides with a published stage id', () => {
    expect(findStage(LOCAL_STAGE_ID)).toBeUndefined();
  });

  it('costs nothing to consent to, because there is nothing to download', () => {
    expect(localStage('model.onnx', 200).sizeMb).toBe(0);
  });

  it('is told apart from the registry stages', () => {
    expect(isLocalStage(localStage('model.onnx', 200))).toBe(true);
    expect(isLocalStage(findStage('small-fp16'))).toBe(false);
    expect(isLocalStage(undefined)).toBe(false);
  });

  it.each([
    ['a path', 'C:\\work\\onnx\\model.onnx', 'model.onnx'],
    ['a posix path', '/home/a/model-int8.onnx', 'model-int8.onnx'],
    ['control characters', 'mo\u0000del\u001f.onnx', 'model.onnx'],
  ])('shows only the file name, stripped of %s', (_label, given, expected) => {
    expect(safeName(given)).toBe(expected);
  });

  it('truncates a name long enough to break the panel', () => {
    const name = `${'a'.repeat(200)}.onnx`;
    expect(safeName(name).length).toBeLessThanOrEqual(48);
  });
});
