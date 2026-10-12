import { expect, it } from 'vitest';
import { createJobContextProxy } from '../../src/common/job-context.js';
it('restores live job snapshots from the durable extension page after background restart', async () => {
  const requests = []; let opens = 0;
  const proxy = createJobContextProxy({ openRunner: async () => { opens++; }, send: async message => {
    requests.push(message.type);
    if (message.type === 'RUNNER_STATE') return { jobs: [{ id: 'live', state: 'downloading', tabId: 1 }] };
    if (message.type === 'RUNNER_START') return { jobId: 'live' };
    if (message.type === 'RUNNER_CANCEL') return { cancelled: true };
  } });
  expect(await proxy.start({ id: '18:progressive' })).toBe('live');
  expect(proxy.get('live').state).toBe('downloading'); expect(opens).toBe(0);
  await proxy.cancel('live'); expect(requests).toContain('RUNNER_CANCEL');
});
it('opens one runner document when no live document exists', async () => {
  let opened = false; let opens = 0; const updates = [];
  const proxy = createJobContextProxy({ openRunner: async () => { opened = true; opens++; }, send: async message => {
    if (message.type === 'RUNNER_STATE') return opened ? { jobs: [] } : undefined;
    if (message.type === 'RUNNER_START') return { jobId: 'new' };
  } });
  proxy.subscribe(job => updates.push(job));
  await proxy.start({});
  proxy.accept({ id: 'new', state: 'muxing' });
  expect(opens).toBe(1); expect(proxy.list()[0].state).toBe('muxing'); expect(updates[0].id).toBe('new');
});
it.each([undefined, { jobs: [] }])('terminates interrupted jobs when their runner disappears %#', async response => {
  const snapshots = [];
  const proxy = createJobContextProxy({ send: async () => response, openRunner: async () => {} });
  proxy.accept({ id: 'lost', state: 'downloading', tabId: 1 });
  proxy.subscribe(job => snapshots.push(job));
  await proxy.hydrate();
  expect(proxy.get('lost')).toMatchObject({ state: 'failed', error: { code: 'RUNNER_INTERRUPTED' } });
  expect(snapshots.at(-1).state).toBe('failed');
});
