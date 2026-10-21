import { InboxStorage } from '../../dist/inbox/storage.js';
const store = new InboxStorage({ root: process.argv[2], lockTimeoutMs: 10000 });
const receiver = {
  runtime: 'codex',
  id: '00000000-0000-0000-0000-000000000001',
};
for (let i = 0; i < 5; i++)
  await store.transaction(receiver, (s) => ({
    state: { ...s, nextSequence: s.nextSequence + 1 },
    result: undefined,
  }));
