/** A WebSocket test client: `next()` resolves with the next JSON message, queued or not yet received. */
export const connectWs = (url: string) => {
  const ws = new WebSocket(url);
  const queue: unknown[] = [];
  let waiting: ((msg: unknown) => void) | null = null;
  const opened = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<CloseEvent>();
  ws.onopen = () => opened.resolve();
  ws.onclose = (e) => closed.resolve(e);
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(msg);
    } else {
      queue.push(msg);
    }
  };
  const next = (): Promise<unknown> => {
    if (queue.length > 0) return Promise.resolve(queue.shift());
    const { promise, resolve } = Promise.withResolvers<unknown>();
    waiting = resolve;
    return promise;
  };
  return { ws, opened: opened.promise, closed: closed.promise, next };
};
