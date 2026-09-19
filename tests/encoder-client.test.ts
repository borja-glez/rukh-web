// The main-thread side of the encoder worker, driven by a fake worker: the real one needs a
// browser, but everything worth testing here is plumbing — the envelope, the correlation by id,
// the progress callback and what happens when the worker dies or is disposed.
import { describe, expect, it, vi } from 'vitest';
import { createEncoder } from '../src/workers/encoder-client';
import { createDecoder } from '../src/workers/decoder-client';
import type { WorkerLike } from '../src/workers/rpc';
import type { ProgressMessage, WorkerResponse } from '../src/lib/worker-protocol';

interface Fake extends WorkerLike {
  /** Everything the client posted, in order. */
  sent: { type: string; id: number; [key: string]: unknown }[];
  /** Delivers a message as if the worker had sent it. */
  answer(message: WorkerResponse): void;
  /** Fires the worker's `error` event. */
  crash(message?: string): void;
  terminated: boolean;
}

function fakeWorker(): Fake {
  const messages: ((event: { data: unknown }) => void)[] = [];
  const errors: ((event: { message?: string }) => void)[] = [];
  return {
    sent: [],
    terminated: false,
    postMessage(message: unknown) {
      this.sent.push(message as Fake['sent'][number]);
    },
    addEventListener(type: 'message' | 'error', listener: (event: never) => void) {
      if (type === 'message') messages.push(listener as (event: { data: unknown }) => void);
      else errors.push(listener as (event: { message?: string }) => void);
    },
    answer(message: WorkerResponse) {
      for (const listener of messages) listener({ data: message });
    },
    crash(message?: string) {
      for (const listener of errors) listener({ message });
    },
    terminate() {
      this.terminated = true;
    },
  } as Fake;
}

const LOAD = {
  stage: 'encoder-fp16',
  url: 'https://huggingface.co/chorcat/rukh-encoder/resolve/main/onnx/model-fp16.onnx',
  sizeBytes: 30_000_000,
  block: 69,
};

describe('the encoder client', () => {
  it('sends encoder-init with an id and reports what came back', async () => {
    const worker = fakeWorker();
    const encoder = createEncoder(worker);
    const ready = encoder.init(LOAD);

    expect(worker.sent).toEqual([{ type: 'encoder-init', id: 1, ...LOAD }]);
    worker.answer({
      type: 'encoder-ready',
      id: 1,
      backend: 'wasm',
      fallbackReason: 'este navegador no expone WebGPU',
      loadMs: 1234,
      block: 69,
      outputs: ['value', 'blunder'],
    });

    await expect(ready).resolves.toEqual({
      backend: 'wasm',
      fallbackReason: 'este navegador no expone WebGPU',
      loadMs: 1234,
      block: 69,
      outputs: ['value', 'blunder'],
    });
  });

  it('streams the download progress without resolving', async () => {
    const worker = fakeWorker();
    const encoder = createEncoder(worker);
    const seen: ProgressMessage[] = [];
    const ready = encoder.init(LOAD, (progress) => seen.push(progress));

    worker.answer({ type: 'progress', id: 1, loaded: 10, total: 100 });
    worker.answer({ type: 'progress', id: 1, loaded: 100, total: 100 });
    expect(seen.map((message) => message.loaded)).toEqual([10, 100]);

    worker.answer({
      type: 'encoder-ready',
      id: 1,
      backend: 'webgpu',
      loadMs: 7,
      block: 69,
      outputs: ['value', 'blunder'],
    });
    await expect(ready).resolves.toMatchObject({ backend: 'webgpu' });
  });

  it('answers the two numbers of one position', async () => {
    const worker = fakeWorker();
    const encoder = createEncoder(worker);
    const ids = Array.from({ length: 69 }, (_, index) => index % 47);
    const evaluation = encoder.evaluate(ids);

    expect(worker.sent).toEqual([{ type: 'evaluate', id: 1, ids }]);
    worker.answer({ type: 'evaluation', id: 1, value: -0.42, blunder: 0.77, inferMs: 3.5 });
    await expect(evaluation).resolves.toEqual({ value: -0.42, blunder: 0.77, inferMs: 3.5 });
  });

  it('correlates answers by id, whatever order they arrive in', async () => {
    const worker = fakeWorker();
    const encoder = createEncoder(worker);
    const first = encoder.evaluate([1]);
    const second = encoder.evaluate([2]);
    expect(worker.sent.map((message) => message.id)).toEqual([1, 2]);

    worker.answer({ type: 'evaluation', id: 2, value: 0.2, blunder: 0.2, inferMs: 1 });
    worker.answer({ type: 'evaluation', id: 1, value: 0.1, blunder: 0.1, inferMs: 1 });
    await expect(second).resolves.toMatchObject({ value: 0.2 });
    await expect(first).resolves.toMatchObject({ value: 0.1 });
  });

  it('rejects with the message the worker sent', async () => {
    const worker = fakeWorker();
    const encoder = createEncoder(worker);
    const evaluation = encoder.evaluate([1]);
    worker.answer({ type: 'error', id: 1, message: 'el encoder todavía no está cargado' });
    await expect(evaluation).rejects.toThrow('el encoder todavía no está cargado');
  });

  it('fails everything in flight when the worker crashes', async () => {
    const worker = fakeWorker();
    const encoder = createEncoder(worker);
    const first = encoder.evaluate([1]);
    const second = encoder.evaluate([2]);
    worker.crash();
    await expect(first).rejects.toThrow('el worker del encoder ha fallado');
    await expect(second).rejects.toThrow('el worker del encoder ha fallado');
  });

  it('disposes the session, terminates the worker and refuses to be used again', async () => {
    const worker = fakeWorker();
    const encoder = createEncoder(worker);
    const gone = encoder.dispose();
    expect(worker.sent).toEqual([{ type: 'dispose', id: 1 }]);
    worker.answer({ type: 'disposed', id: 1 });
    await gone;

    expect(worker.terminated).toBe(true);
    await expect(encoder.evaluate([1])).rejects.toThrow(/ya se ha cerrado/);
    // A second dispose is a no-op, not a second `postMessage`.
    await encoder.dispose();
    expect(worker.sent).toHaveLength(1);
  });

  it('ignores a stray message that is not a known response', async () => {
    const worker = fakeWorker();
    const encoder = createEncoder(worker);
    const evaluation = encoder.evaluate([1]);
    worker.answer({ hello: 'there' } as unknown as WorkerResponse);
    worker.answer({ type: 'evaluation', id: 9, value: 0, blunder: 0, inferMs: 0 });
    const pending = vi.fn();
    void evaluation.then(pending, pending);
    await Promise.resolve();
    expect(pending).not.toHaveBeenCalled();

    worker.answer({ type: 'evaluation', id: 1, value: 0, blunder: 0, inferMs: 0 });
    await expect(evaluation).resolves.toMatchObject({ value: 0 });
  });

  it('shares its plumbing with the decoder client without sharing a worker', async () => {
    // Same envelope, different verbs: the encoder must never be driven through the decoder's
    // worker, so each client owns one and the requests they post are not interchangeable.
    const encoderWorker = fakeWorker();
    const decoderWorker = fakeWorker();
    const encoder = createEncoder(encoderWorker);
    const decoder = createDecoder(decoderWorker);
    void encoder.evaluate([1]).catch(() => undefined);
    void decoder.logits([1]).catch(() => undefined);
    expect(encoderWorker.sent.map((message) => message.type)).toEqual(['evaluate']);
    expect(decoderWorker.sent.map((message) => message.type)).toEqual(['logits']);
  });
});
