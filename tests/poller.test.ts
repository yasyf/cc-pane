import { expect, test } from "bun:test"

import { Poller, type PollerClock } from "../src/data/poller.ts"

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Drain the microtask queue so producer .then reactions run — no real timers.
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function nth<T>(rows: readonly T[], i: number): T {
  const row = rows[i]
  if (row === undefined) throw new Error(`no element at index ${i}`)
  return row
}

// A hand-driven stand-in for the setInterval/clearInterval pair and Date.now().
class FakeClock implements PollerClock {
  #time = 0
  #callback: (() => void) | null = null
  #intervalMs: number | null = null

  now(): number {
    return this.#time
  }

  setTime(time: number): void {
    this.#time = time
  }

  get scheduled(): boolean {
    return this.#callback !== null
  }

  get intervalMs(): number | null {
    return this.#intervalMs
  }

  every(intervalMs: number, callback: () => void): () => void {
    if (this.#callback !== null) throw new Error("fake clock already scheduled")
    this.#callback = callback
    this.#intervalMs = intervalMs
    return () => {
      this.#callback = null
      this.#intervalMs = null
    }
  }

  tick(): void {
    if (this.#callback === null) throw new Error("no interval scheduled")
    this.#callback()
  }
}

function setup() {
  const clock = new FakeClock()
  const deferreds: Array<Deferred<string>> = []
  const producer = (): Promise<string> => {
    const d = deferred<string>()
    deferreds.push(d)
    return d.promise
  }
  const results: string[] = []
  const poller = new Poller<string>({
    producer,
    intervalMs: 2000,
    onResult: (r) => results.push(r),
    clock,
  })
  return { clock, poller, results, deferreds, calls: () => deferreds.length }
}

test("start wires the configured interval and a tick runs the producer once", () => {
  const { clock, poller, calls } = setup()
  poller.start()
  expect(poller.running).toBe(true)
  expect(clock.scheduled).toBe(true)
  expect(clock.intervalMs).toBe(2000)

  clock.tick()
  expect(calls()).toBe(1)
})

test("a tick while a poll is in flight is skipped, never queued", () => {
  const { clock, poller, calls } = setup()
  poller.start()
  clock.tick()
  expect(calls()).toBe(1)

  clock.tick() // first poll still pending: overlap guard skips this one
  clock.tick()
  expect(calls()).toBe(1)
})

test("a resolved poll delivers onResult and records lastSuccessAt", async () => {
  const { clock, poller, results, deferreds } = setup()
  poller.start()
  clock.tick()

  clock.setTime(1234)
  nth(deferreds, 0).resolve("frame-a")
  await flush()

  expect(results).toEqual(["frame-a"])
  expect(poller.lastSuccessAt).toBe(1234)
  expect(poller.lastError).toBeNull()
  expect(poller.lastErrorAt).toBeNull()
})

test("a rejected poll records lastError without throwing, and the next tick still fires", async () => {
  const { clock, poller, results, deferreds, calls } = setup()
  poller.start()
  clock.tick()

  clock.setTime(5000)
  const boom = new Error("boom")
  nth(deferreds, 0).reject(boom)
  await flush()

  expect(poller.lastError).toBe(boom)
  expect(poller.lastErrorAt).toBe(5000)
  expect(poller.lastSuccessAt).toBeNull()
  expect(results).toEqual([])

  clock.tick() // in-flight flag cleared on failure, so the next poll proceeds
  expect(calls()).toBe(2)
  nth(deferreds, 1).resolve("frame-b")
  await flush()
  expect(results).toEqual(["frame-b"])
})

test("a non-Error rejection reason is normalized to an Error", async () => {
  const { clock, poller, deferreds } = setup()
  poller.start()
  clock.tick()

  nth(deferreds, 0).reject("string failure")
  await flush()

  expect(poller.lastError).toBeInstanceOf(Error)
  expect(poller.lastError?.message).toBe("string failure")
})

test("stop cancels the interval and discards an in-flight resolution", async () => {
  const { clock, poller, results, deferreds, calls } = setup()
  poller.start()
  clock.tick()
  expect(calls()).toBe(1)

  poller.stop()
  expect(poller.running).toBe(false)
  expect(clock.scheduled).toBe(false) // interval cleared: no further ticks or producer calls

  nth(deferreds, 0).resolve("late-frame") // in-flight call settles after stop
  await flush()

  expect(results).toEqual([])
  expect(poller.lastSuccessAt).toBeNull()
  expect(calls()).toBe(1)
})

test("stop discards an in-flight rejection, leaving no lastError", async () => {
  const { clock, poller, deferreds } = setup()
  poller.start()
  clock.tick()

  poller.stop()
  nth(deferreds, 0).reject(new Error("late-boom"))
  await flush()

  expect(poller.lastError).toBeNull()
  expect(poller.lastErrorAt).toBeNull()
})

test("start throws when the poller is already running", () => {
  const { poller } = setup()
  poller.start()
  expect(() => poller.start()).toThrow("poller already started")
})
