/** Date runs share the caller's model budget; changing capacity never cancels active work. */
export function createEvaluationScheduler<Job extends {
  date: string; download: string; downloaded?: unknown; evaluation: string; nextEvaluationAt: number;
}>(
  capacity: () => number,
  evaluate: (job: Job) => Promise<void>,
  failed: (error: unknown) => void,
  once = false,
) {
  const running = new Map<string, Promise<void>>();
  function track(job: Job, work: Promise<void>) {
    if (running.has(job.date)) throw new Error("Date is already evaluating: " + job.date);
    running.set(job.date, work.catch(failed).finally(() => { running.delete(job.date); }));
  }
  return {
    get size() { return running.size; },
    track,
    tick(jobs: Job[]) {
      const ready = jobs.filter(job => !running.has(job.date) &&
        (job.download === "ready" || (job.download === "downloading" && job.downloaded !== undefined)) &&
        (job.evaluation === "pending" || (!once && job.evaluation === "retry")) && Date.now() >= job.nextEvaluationAt)
        .sort((a, b) => Number(b.evaluation === "retry") - Number(a.evaluation === "retry") || a.date.localeCompare(b.date));
      for (const job of ready) {
        if (running.size >= capacity()) break;
        track(job, Promise.resolve().then(() => evaluate(job)));
      }
    },
    async settled() { await Promise.all(running.values()); },
  };
}
