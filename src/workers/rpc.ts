// Main-thread plumbing shared by the two worker clients: give every request an id, keep the
// promise that is waiting for it, route the answer back and never leave a caller hanging when the
// worker dies. The decoder and the encoder speak different verbs but the same envelope, so this
// is written once and neither client repeats it.
import { asResponse, type ProgressMessage, type WorkerRequest } from '../lib/worker-protocol';

/**
 * The part of `Worker` this module uses. A `Worker` satisfies it, and so does a plain object,
 * which is how the clients are tested without a browser.
 */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error', listener: (event: { message?: string }) => void): void;
  terminate(): void;
}

/** `Omit` over a union collapses it, so the distribution is written out explicitly. */
export type Unidentified<T> = T extends WorkerRequest ? Omit<T, 'id'> : never;

export interface Rpc {
  /** Posts a request with a fresh id and resolves with the message that answers it. */
  send<T>(
    request: Unidentified<WorkerRequest>,
    onProgress?: (progress: ProgressMessage) => void,
    /**
     * Buffers to hand over instead of copying. A 230 MB model posted by value is 230 MB cloned
     * before the worker sees any of it; transferred, it changes owner and the sender's view is
     * detached. Callers that transfer must not read the buffer afterwards.
     */
    transfer?: Transferable[],
  ): Promise<T>;
  /** Rejects everything in flight and terminates the worker; the handle is unusable afterwards. */
  close(reason: string): void;
  /** True once `close` has run. */
  readonly closed: boolean;
}

interface Pending {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: ProgressMessage) => void;
}

/**
 * `crashMessage` is what a caller is told when the worker itself dies; `close` supplies its own
 * reason for the requests it cancels and for everything sent afterwards.
 */
export function createRpc(worker: WorkerLike, crashMessage: string): Rpc {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closedReason: string | null = null;

  const fail = (error: Error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  worker.addEventListener('message', (event: { data: unknown }) => {
    const message = asResponse(event.data);
    if (!message) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    if (message.type === 'progress') {
      entry.onProgress?.(message);
      return;
    }
    pending.delete(message.id);
    if (message.type === 'error') {
      entry.reject(new Error(message.message));
      return;
    }
    (entry.resolve as (value: unknown) => void)(message);
  });

  worker.addEventListener('error', (event: { message?: string }) => {
    fail(new Error(event.message || crashMessage));
  });

  return {
    get closed() {
      return closedReason !== null;
    },
    send<T>(
      request: Unidentified<WorkerRequest>,
      onProgress?: (p: ProgressMessage) => void,
      transfer?: Transferable[],
    ) {
      if (closedReason !== null) return Promise.reject(new Error(closedReason));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: never) => void, reject, onProgress });
        worker.postMessage({ ...request, id } as WorkerRequest, transfer);
      });
    },
    close(reason: string) {
      if (closedReason !== null) return;
      closedReason = reason;
      fail(new Error(reason));
      worker.terminate();
    },
  };
}
