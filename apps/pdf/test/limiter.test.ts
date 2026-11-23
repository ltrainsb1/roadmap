import { expect, test } from 'vitest';
import { BusyError, createLimiter } from '../src/limiter.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('FR-3.4: the limiter refuses a run past its maximum at once and frees the slot when a run settles', async () => {
  const limiter = createLimiter(2);
  const first = deferred<string>();
  const second = deferred<string>();
  const a = limiter.run(() => first.promise);
  const b = limiter.run(() => second.promise);
  let called = false;
  await expect(
    limiter.run(() => {
      called = true;
      return Promise.resolve('c');
    }),
  ).rejects.toBeInstanceOf(BusyError);
  expect(called).toBe(false);

  first.resolve('a');
  await expect(a).resolves.toBe('a');
  await expect(limiter.run(() => Promise.resolve('d'))).resolves.toBe('d');

  second.reject(new Error('boom'));
  await expect(b).rejects.toThrow('boom');
  // Both slots are free again: two more can run side by side.
  const third = deferred<string>();
  const c = limiter.run(() => third.promise);
  await expect(limiter.run(() => Promise.resolve('e'))).resolves.toBe('e');
  third.resolve('c');
  await expect(c).resolves.toBe('c');
});

test('FR-3.4: a run whose function throws before returning a promise still frees its slot', async () => {
  const limiter = createLimiter(1);
  await expect(
    limiter.run(() => {
      throw new Error('sync');
    }),
  ).rejects.toThrow('sync');
  await expect(limiter.run(() => Promise.resolve(1))).resolves.toBe(1);
});
