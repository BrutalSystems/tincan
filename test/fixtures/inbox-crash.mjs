import { promises as fs } from 'node:fs';
import { InboxService } from '../../dist/inbox/service.js';
import { InboxStorage } from '../../dist/inbox/storage.js';
const args = JSON.parse(process.argv[3]);
const rename = fs.rename.bind(fs);
fs.rename = async (...paths) => {
  await rename(...paths);
  process.exit(75);
};
await new InboxService(new InboxStorage({ root: process.argv[2] })).enqueue(
  args,
);
