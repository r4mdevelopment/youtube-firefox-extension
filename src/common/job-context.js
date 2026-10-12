// Browser bootstrap boundary: media work lives in an extension document so that
// popup closure and event-page/service-worker suspension cannot discard its bytes.
export function createJobContextProxy({ send, openRunner, initialJobs = [] }) {
  const jobs = new Map(initialJobs.map(j => [j.id, { ...j, ...(!['complete', 'failed', 'cancelled'].includes(j.state) ? { state: 'failed', error: { code: 'BACKGROUND_RESTARTED', message: 'Загрузка прервана. Начните её заново.' } } : {}) }]));
  const listeners = new Set(); let preparing;
  const accept = snapshot => {
    jobs.set(snapshot.id, structuredClone(snapshot));
    for (const listener of listeners) listener(structuredClone(snapshot));
  };
  const reconcile = state => {
    const present = new Set(state?.jobs?.map(j => j.id) ?? []);
    for (const job of jobs.values()) if (!present.has(job.id) && !['complete', 'failed', 'cancelled'].includes(job.state)) {
      accept({ ...job, state: 'failed', error: { code: 'RUNNER_INTERRUPTED', message: 'Страница загрузки закрыта или перезапущена. Начните загрузку заново.' } });
    }
    for (const job of state?.jobs ?? []) accept(job);
  };
  const ensure = async () => {
    const state = await send({ type: 'RUNNER_STATE' }).catch(() => null);
    reconcile(state);
    if (state?.jobs) return;
    if (!preparing) preparing = openRunner().finally(() => { preparing = null; });
    await preparing;
  };
  return {
    accept,
    async hydrate() {
      const state = await send({ type: 'RUNNER_STATE' }).catch(() => null);
      reconcile(state);
    },
    async start(choice) { await ensure(); const result = await send({ type: 'RUNNER_START', payload: choice }); if (result?.error) throw Object.assign(new Error(result.error.message), result.error); return result.jobId; },
    async cancel(jobId) { await send({ type: 'RUNNER_CANCEL', payload: { jobId } }); },
    get(id) { const job = jobs.get(id); return job ? structuredClone(job) : null; },
    list() { return [...jobs.values()].map(j => structuredClone(j)); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
