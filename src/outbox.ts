type Entry<T> = { item: T; expiresAt: number };

export const createOutbox = <T>({ maxSize, ttl }: { maxSize: number; ttl: number }) => {
  const queues = new Map<string, Entry<T>[]>();

  const alive = (key: string) => (queues.get(key) ?? []).filter(({ expiresAt }) => expiresAt > Date.now());

  return {
    add(key: string, item: T) {
      const queue = alive(key);
      if (queue.length >= maxSize) queue.shift();
      queue.push({ item, expiresAt: Date.now() + ttl });
      queues.set(key, queue);
      return queue.length;
    },

    take(key: string) {
      const items = alive(key).map(({ item }) => item);
      queues.delete(key);
      return items;
    },

    putBack(key: string, items: T[]) {
      const expiresAt = Date.now() + ttl;
      queues.set(key, [...items.map((item) => ({ item, expiresAt })), ...alive(key)]);
    },

    size: () => [...queues.values()].reduce((total, queue) => total + queue.length, 0),
  };
};
