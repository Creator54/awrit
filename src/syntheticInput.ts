export function createSyntheticInputGuard() {
  const counts = new WeakMap<object, number>();
  return {
    active(target: object): boolean { return (counts.get(target) ?? 0) > 0; },
    run<T>(target: object, send: () => T): T {
      counts.set(target, (counts.get(target) ?? 0) + 1);
      try { return send(); }
      finally {
        const remaining = (counts.get(target) ?? 1) - 1;
        if (remaining) counts.set(target, remaining);
        else counts.delete(target);
      }
    },
  };
}
