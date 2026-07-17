// Overlap-safe poller over an async producer: one tick in flight at a time, a
// rejection becomes displayed state, and a call settling after stop() is discarded.

export interface PollerClock {
  now(): number
  // Fire `callback` every `intervalMs`; returns a cancel fn (the clearInterval half).
  every(intervalMs: number, callback: () => void): () => void
}

export interface PollerOptions<T> {
  readonly producer: () => Promise<T>
  readonly intervalMs: number
  readonly onResult: (result: T) => void
  readonly clock?: PollerClock
}

export const systemClock: PollerClock = {
  now: () => Date.now(),
  every: (intervalMs, callback) => {
    const handle = setInterval(callback, intervalMs)
    return () => clearInterval(handle)
  },
}

// lastSuccessAt and lastError* coexist: a failed poll still remembers the last fresh time.
export class Poller<T> {
  readonly #producer: () => Promise<T>
  readonly #intervalMs: number
  readonly #onResult: (result: T) => void
  readonly #clock: PollerClock

  #cancel: (() => void) | null = null
  #inFlight = false
  #epoch = 0

  #lastSuccessAt: number | null = null
  #lastError: Error | null = null
  #lastErrorAt: number | null = null

  constructor(options: PollerOptions<T>) {
    this.#producer = options.producer
    this.#intervalMs = options.intervalMs
    this.#onResult = options.onResult
    this.#clock = options.clock ?? systemClock
  }

  get running(): boolean {
    return this.#cancel !== null
  }

  get lastSuccessAt(): number | null {
    return this.#lastSuccessAt
  }

  get lastError(): Error | null {
    return this.#lastError
  }

  get lastErrorAt(): number | null {
    return this.#lastErrorAt
  }

  start(): void {
    if (this.#cancel !== null) throw new Error("poller already started")
    this.#cancel = this.#clock.every(this.#intervalMs, () => this.#tick())
  }

  stop(): void {
    if (this.#cancel === null) return
    this.#cancel()
    this.#cancel = null
    this.#inFlight = false
    this.#epoch += 1 // invalidate any in-flight call so its result is discarded
  }

  #tick(): void {
    if (this.#inFlight) return // previous poll still running: skip, never overlap or queue
    this.#inFlight = true
    const epoch = this.#epoch
    this.#producer().then(
      (result) => this.#onSuccess(epoch, result),
      (reason: unknown) => this.#onFailure(epoch, reason),
    )
  }

  #onSuccess(epoch: number, result: T): void {
    if (epoch !== this.#epoch) return // settled after stop(): discard, no late delivery
    this.#inFlight = false
    this.#lastSuccessAt = this.#clock.now()
    this.#onResult(result)
  }

  #onFailure(epoch: number, reason: unknown): void {
    if (epoch !== this.#epoch) return
    this.#inFlight = false
    this.#lastError = reason instanceof Error ? reason : new Error(String(reason))
    this.#lastErrorAt = this.#clock.now()
  }
}
