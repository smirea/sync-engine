import { startSyncWorker } from '../src/worker.ts';
import { schema } from './schema.ts';

declare const __ENDPOINT__: string;

const wait = new URLSearchParams(self.location.search).has('wait');
startSyncWorker({ schema, endpoint: __ENDPOINT__, filename: 'web-test.db', token: wait ? null : undefined });
