/** The permit covers one provider stream, never the tool work between model turns. */
export function controlledModelStream<A extends unknown[], S extends { result(): Promise<unknown> }>(
  stream: (...args: A) => S | Promise<S>,
  acquire: (signal?: AbortSignal) => Promise<() => Promise<void>>,
  signalFor: (...args: A) => AbortSignal | undefined,
): (...args: A) => Promise<S> {
  return async (...args) => {
    const release = await acquire(signalFor(...args));
    try {
      const response = await stream(...args);
      // result() observes completion without consuming or changing stream events.
      void response.result().then(release, release).catch(() => {});
      return response;
    } catch (error) {
      await release();
      throw error;
    }
  };
}
