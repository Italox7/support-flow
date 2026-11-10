import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPasswordGate, PasswordHashBusyError } from './password.js';

/** Uma tarefa que só termina quando o teste manda. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('createPasswordGate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('nunca roda mais que `permits` ao mesmo tempo', async () => {
    const gate = createPasswordGate({ permits: 2, maxQueue: 10, maxWaitMs: 60_000 });
    let running = 0;
    let peak = 0;
    const tasks = Array.from({ length: 7 }, () => deferred());
    const runs = tasks.map((task) =>
      gate.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await task.promise;
        running -= 1;
      }),
    );
    for (const task of tasks) {
      await flush();
      expect(running).toBeLessThanOrEqual(2);
      task.resolve();
    }
    await Promise.all(runs);
    expect(peak).toBe(2);
    expect(gate.stats()).toEqual({ active: 0, queued: 0 });
  });

  it('com a fila cheia, recusa na hora sem rodar a tarefa', async () => {
    const gate = createPasswordGate({ permits: 1, maxQueue: 2, maxWaitMs: 60_000 });
    const hold = deferred();
    const holding = gate.run(() => hold.promise);
    const queued = [gate.run(async () => 'a'), gate.run(async () => 'b')];
    const extra = vi.fn(async () => 'c');

    await expect(gate.run(extra)).rejects.toBeInstanceOf(PasswordHashBusyError);
    expect(extra).not.toHaveBeenCalled();

    hold.resolve();
    await holding;
    await expect(Promise.all(queued)).resolves.toEqual(['a', 'b']);
  });

  it('quem estoura a espera sai da fila e nunca roda depois', async () => {
    vi.useFakeTimers();
    const gate = createPasswordGate({ permits: 1, maxQueue: 5, maxWaitMs: 3_000 });
    const hold = deferred();
    const holding = gate.run(() => hold.promise);
    const late = vi.fn(async () => undefined);
    const waiting = gate.run(late);
    const rejected = expect(waiting).rejects.toBeInstanceOf(PasswordHashBusyError);

    await vi.advanceTimersByTimeAsync(3_000);
    await rejected;
    expect(gate.stats()).toEqual({ active: 1, queued: 0 });

    hold.resolve();
    await holding;
    expect(late).not.toHaveBeenCalled();
    expect(gate.stats()).toEqual({ active: 0, queued: 0 });
  });

  it('erro na tarefa solta a vaga', async () => {
    const gate = createPasswordGate({ permits: 1, maxQueue: 5, maxWaitMs: 60_000 });
    await expect(gate.run(() => Promise.reject(new Error('argon2')))).rejects.toThrow('argon2');
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
    expect(gate.stats()).toEqual({ active: 0, queued: 0 });
  });

  it('a prioridade passa à frente da fila, sem teto, e sem passar das vagas', async () => {
    vi.useFakeTimers();
    const gate = createPasswordGate({ permits: 1, maxQueue: 1, maxWaitMs: 3_000 });
    const order: string[] = [];
    const hold = deferred();
    const holding = gate.run(() => hold.promise);
    const common = gate.run(async () => void order.push('comum'));
    // Fila comum cheia, mas a prioridade entra; e não expira com o timeout comum.
    const first = gate.run(async () => void order.push('prioridade 1'), true);
    const second = gate.run(async () => void order.push('prioridade 2'), true);
    expect(gate.stats()).toEqual({ active: 1, queued: 3 });

    await vi.advanceTimersByTimeAsync(2_000);
    hold.resolve();
    await Promise.all([holding, common, first, second]);
    expect(order).toEqual(['prioridade 1', 'prioridade 2', 'comum']);
  });
});

describe('o argon2 só passa pelo semáforo', () => {
  it('só password.ts importa o argon2', () => {
    const root = join(import.meta.dirname, '..');
    const files = (readdirSync(root, { recursive: true }) as string[])
      .filter((file) => file.endsWith('.ts'))
      .filter((file) =>
        /from ['"]argon2['"]|require\(['"]argon2['"]\)/.test(
          readFileSync(join(root, file), 'utf8'),
        ),
      )
      .map((file) => relative(root, join(root, file)).replaceAll('\\', '/'));
    expect(files).toEqual(['auth/password.ts']);
  });
});
