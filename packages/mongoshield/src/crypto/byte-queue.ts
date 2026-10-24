/**
 * A FIFO of byte buffers that hands out fixed-size slices.
 *
 * Streams deliver data in arbitrary pieces while age works in 64 KiB chunks.
 * Appending to one growing Buffer would copy on every write; this queue keeps
 * the pieces and copies only once, when a slice is taken.
 */
export class ByteQueue {
  #parts: Buffer[] = [];
  #length = 0;

  /** Total number of queued bytes. */
  get length(): number {
    return this.#length;
  }

  /** Appends bytes to the end of the queue (zero-length input is ignored). */
  push(bytes: Buffer): void {
    if (bytes.length === 0) return;
    this.#parts.push(bytes);
    this.#length += bytes.length;
  }

  /** Removes and returns the first `size` bytes (or fewer if the queue is shorter). */
  take(size: number): Buffer {
    const wanted = Math.min(size, this.#length);
    const pieces: Buffer[] = [];
    let collected = 0;
    while (collected < wanted) {
      const part = this.#parts[0];
      if (part === undefined) break;
      const needed = wanted - collected;
      if (part.length <= needed) {
        pieces.push(part);
        this.#parts.shift();
        collected += part.length;
      } else {
        pieces.push(part.subarray(0, needed));
        this.#parts[0] = part.subarray(needed);
        collected += needed;
      }
    }
    this.#length -= collected;
    return pieces.length === 1 && pieces[0] !== undefined
      ? pieces[0]
      : Buffer.concat(pieces, collected);
  }

  /** Removes and returns everything queued. */
  takeAll(): Buffer {
    return this.take(this.#length);
  }

  /**
   * Returns the first `size` bytes (or fewer) as one contiguous buffer without
   * removing them. They are merged into a single front piece, so peeking again
   * does not copy again.
   */
  peek(size: number): Buffer {
    const front = this.take(size);
    this.#parts.unshift(front);
    this.#length += front.length;
    return front;
  }

  /** Returns all queued bytes as one contiguous buffer without removing them. */
  peekAll(): Buffer {
    return this.peek(this.#length);
  }
}
