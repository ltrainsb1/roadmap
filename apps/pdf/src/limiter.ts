/** Thrown at once when every slot is taken; there is no queue. */
export class BusyError extends Error {
  constructor() {
    super('every render slot is taken');
    this.name = 'BusyError';
  }
}

/** Runs at most `max` functions at a time. A slot is held until the function's promise settles, however it settles. */
export function createLimiter(max: number): { run<T>(fn: () => Promise<T>): Promise<T> } {
  let running = 0;
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (running >= max) throw new BusyError();
      running += 1;
      try {
        return await fn();
      } finally {
        running -= 1;
      }
    },
  };
}
