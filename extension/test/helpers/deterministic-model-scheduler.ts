export type DeterministicTimerHandle = ReturnType<typeof setTimeout>;

interface ScheduledTimer {
  readonly id: number;
  readonly dueAt: number;
  readonly callback: () => void;
}

/** Test-only clock with deterministic wall time and FIFO timers at equal due times. */
export class DeterministicFakeClock {
  private currentTime: number;
  private nextTimerId = 1;
  private readonly timers = new Map<number, ScheduledTimer>();

  constructor(startTime = 0) {
    if (!Number.isFinite(startTime)) throw new RangeError('startTime must be finite');
    this.currentTime = startTime;
  }

  now(): number {
    return this.currentTime;
  }

  setTimeout<TArgs extends unknown[]>(
    callback: (...args: TArgs) => void,
    delayMs = 0,
    ...args: TArgs
  ): DeterministicTimerHandle {
    const id = this.nextTimerId++;
    const finiteDelay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
    this.timers.set(id, {
      id,
      dueAt: this.currentTime + finiteDelay,
      callback: () => callback(...args),
    });
    return id as unknown as DeterministicTimerHandle;
  }

  clearTimeout(handle: DeterministicTimerHandle | undefined): void {
    if (handle === undefined) return;
    this.timers.delete(handle as unknown as number);
  }

  pendingTimerCount(): number {
    return this.timers.size;
  }

  advanceBy(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError('milliseconds must be a finite non-negative number');
    }
    this.advanceTo(this.currentTime + milliseconds);
  }

  advanceTo(targetTime: number): void {
    if (!Number.isFinite(targetTime) || targetTime < this.currentTime) {
      throw new RangeError('targetTime must be finite and not precede now');
    }
    for (;;) {
      const next = this.nextDueTimer(targetTime);
      if (!next) break;
      this.timers.delete(next.id);
      this.currentTime = next.dueAt;
      next.callback();
    }
    this.currentTime = targetTime;
  }

  runAll(maxCallbacks = 10_000): void {
    let callbacks = 0;
    while (this.timers.size > 0) {
      if (callbacks >= maxCallbacks) {
        throw new Error(`fake clock exceeded ${maxCallbacks} timer callbacks`);
      }
      const next = this.nextDueTimer(Number.POSITIVE_INFINITY)!;
      this.timers.delete(next.id);
      this.currentTime = next.dueAt;
      next.callback();
      callbacks += 1;
    }
  }

  private nextDueTimer(targetTime: number): ScheduledTimer | undefined {
    let next: ScheduledTimer | undefined;
    for (const timer of this.timers.values()) {
      if (timer.dueAt > targetTime) continue;
      if (!next || timer.dueAt < next.dueAt
        || (timer.dueAt === next.dueAt && timer.id < next.id)) {
        next = timer;
      }
    }
    return next;
  }
}

/** Enumerate every ordering of a small boundary set. */
export function enumeratePermutations<T>(values: readonly T[]): T[][] {
  if (values.length === 0) return [[]];
  const permutations: T[][] = [];
  for (let index = 0; index < values.length; index += 1) {
    const head = values[index]!;
    const tail = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const suffix of enumeratePermutations(tail)) permutations.push([head, ...suffix]);
  }
  return permutations;
}

/** Fisher-Yates shuffle backed by a stable 32-bit PRNG, never Math.random. */
export function fixedSeedShuffle<T>(values: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const replacement = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[replacement]] = [shuffled[replacement]!, shuffled[index]!];
  }
  return shuffled;
}

/** Run model steps through fake timers so schedule order and timestamps are reproducible. */
export function runDeterministicSchedule<T>(
  clock: DeterministicFakeClock,
  steps: readonly T[],
  run: (step: T, occurredAt: number) => void,
): void {
  for (const [index, step] of steps.entries()) {
    clock.setTimeout(() => run(step, clock.now()), index + 1);
  }
  clock.runAll();
}
