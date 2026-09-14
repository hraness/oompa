import { MAX_NATIVE_OUTPUT_CHUNK_BYTES, NativeProtocolError } from "./protocol.ts";

type Reader = Readonly<{
  resolve: (value: IteratorResult<Uint8Array>) => void;
  reject: (error: unknown) => void;
}>;

/** One native pump and one consumer. Consumer release permits draining but is
 * deliberately separate from the actual native EOF observation. */
export class NativeByteQueue implements AsyncIterable<Uint8Array> {
  readonly delivered: Promise<void>;
  #delivered: () => void = () => {};
  #deliveryFailed: (error: unknown) => void = () => {};
  readonly #maximumBytes: number;
  readonly #onAbandoned: () => void;
  readonly #chunks: Uint8Array[] = [];
  #bytes = 0;
  #reader: Reader | null = null;
  #capacityWaiter: (() => void) | null = null;
  #pushing = false;
  #claimed = false;
  #ended = false;
  #abandoned = false;
  #failure: unknown;
  #failed = false;

  constructor(maximumBytes: number, onAbandoned: () => void) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < MAX_NATIVE_OUTPUT_CHUNK_BYTES
      || maximumBytes > 1024 * 1024) throw new NativeProtocolError();
    this.#maximumBytes = maximumBytes;
    this.#onAbandoned = onAbandoned;
    this.delivered = new Promise<void>((resolve, reject) => { this.#delivered = resolve; this.#deliveryFailed = reject; });
    void this.delivered.catch(() => {});
  }

  get nativeEofObserved(): boolean { return this.#ended; }
  get bufferedBytes(): number { return this.#bytes; }

  async push(input: Uint8Array): Promise<void> {
    if (input.byteLength < 1 || input.byteLength > MAX_NATIVE_OUTPUT_CHUNK_BYTES
      || this.#pushing || this.#ended) throw new NativeProtocolError();
    if (this.#abandoned || this.#failed) return;
    this.#pushing = true;
    try {
      // The pump exclusively owns this frame while push is pending. Copy only
      // after capacity admission; one pending chunk is bounded by the wire cap.
      while (this.#bytes + input.byteLength > this.#maximumBytes) {
        await new Promise<void>(resolve => { this.#capacityWaiter = resolve; });
        if (this.#discarding()) return;
        if (this.nativeEofObserved) throw new NativeProtocolError();
      }
      const bytes = input.slice();
      if (this.#reader !== null) {
        const reader = this.#reader;
        this.#reader = null;
        reader.resolve({ done: false, value: bytes });
      } else {
        this.#chunks.push(bytes);
        this.#bytes += bytes.byteLength;
      }
    } finally { this.#pushing = false; }
  }

  end(): void {
    if (this.#ended) throw new NativeProtocolError();
    this.#ended = true;
    if (this.#reader !== null) {
      const reader = this.#reader;
      this.#reader = null;
      reader.resolve({ done: true, value: undefined });
    }
    this.#wakeCapacity();
    if (this.#bytes === 0 && !this.#failed && !this.#abandoned) this.#delivered();
  }

  fail(error: unknown): void {
    if (!this.#failed) { this.#failed = true; this.#failure = error; }
    this.#deliveryFailed(this.#failure);
    this.#chunks.length = 0;
    this.#bytes = 0;
    if (this.#reader !== null) {
      const reader = this.#reader;
      this.#reader = null;
      reader.reject(this.#failure);
    }
    this.#wakeCapacity();
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.#claimed) throw new NativeProtocolError();
    this.#claimed = true;
    return {
      next: () => this.#next(),
      return: () => {
        if ((!this.#ended || this.#bytes > 0 || this.#pushing) && !this.#abandoned) {
          this.#abandoned = true;
          this.#deliveryFailed(new NativeProtocolError());
          this.#onAbandoned();
        }
        this.#chunks.length = 0;
        this.#bytes = 0;
        if (this.#reader !== null) {
          const reader = this.#reader;
          this.#reader = null;
          reader.resolve({ done: true, value: undefined });
        }
        this.#wakeCapacity();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }

  #next(): Promise<IteratorResult<Uint8Array>> {
    if (this.#failed) return Promise.reject(this.#failure);
    if (this.#reader !== null) return Promise.reject(new NativeProtocolError());
    const bytes = this.#chunks.shift();
    if (bytes !== undefined) {
      this.#bytes -= bytes.byteLength;
      this.#wakeCapacity();
      if (this.#bytes === 0 && this.#ended) this.#delivered();
      return Promise.resolve({ done: false, value: bytes });
    }
    if (this.#ended || this.#abandoned) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => { this.#reader = { resolve, reject }; });
  }

  #wakeCapacity(): void {
    const wake = this.#capacityWaiter;
    this.#capacityWaiter = null;
    wake?.();
  }

  #discarding(): boolean { return this.#abandoned || this.#failed; }
}
