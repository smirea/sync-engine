import { startSyncWorker } from '../src/worker.ts';
import { schema } from './schema.ts';

const params = new URLSearchParams(self.location.search);
const endpoint = params.get('endpoint');
if (!endpoint) throw new Error('the test page passes ?endpoint=');
// WebKit keeps OPFS across persistent contexts, so each server, one per test, gets its own file.
startSyncWorker({
	schema,
	endpoint,
	filename: `web-test-${new URL(endpoint).port}.db`,
	token: params.has('wait') ? null : undefined,
});
