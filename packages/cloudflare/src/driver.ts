import type { DurableObjectStorage } from '@cloudflare/workers-types';
import type { SqlDriver, Values } from '../../core/src/index.ts';

export type DurableStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

export function durableDriver(storage: DurableStorage): SqlDriver {
	return {
		exec: (sql, params = []) => storage.sql.exec<Values>(sql, ...params).toArray(),
		transaction: fn => storage.transactionSync(fn),
	};
}
