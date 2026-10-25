// Tiny assertion helpers (no external imports available).

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) =>
    (a as Record<string, unknown>)[k] !== undefined
  );
  const kb = Object.keys(b).filter((k) =>
    (b as Record<string, unknown>)[k] !== undefined
  );
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}

export function assert(cond: unknown, msg = "Assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (!equal(actual, expected)) {
    throw new Error(
      `${msg ?? "Values differ"}\n  actual:   ${
        JSON.stringify(actual)
      }\n  expected: ${JSON.stringify(expected)}`,
    );
  }
}

export function assertThrows(
  fn: () => unknown,
  cls: new (...a: never[]) => Error = Error,
): Error {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof cls)) throw new Error(`Threw wrong error type: ${e}`);
    return e;
  }
  throw new Error("Expected function to throw");
}

export async function assertRejects(
  fn: () => Promise<unknown>,
  cls: new (...a: never[]) => Error = Error,
): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof cls)) {
      throw new Error(`Rejected with wrong error type: ${e}`);
    }
    return e;
  }
  throw new Error("Expected promise to reject");
}
