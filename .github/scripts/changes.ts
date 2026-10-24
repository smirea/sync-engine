import { $ } from 'bun';
import { appendFileSync } from 'node:fs';
import { extname } from 'node:path';
import { env } from 'node:process';

const { SCAFFOLD_TYPE: kind, BASE_SHA: base, HEAD_SHA: head, EVENT_NAME: event, GITHUB_OUTPUT: output } = env;
if (!kind || !head || !event || !output) throw new Error('Missing change detection environment');

const full = event === 'workflow_dispatch' || !base || /^0+$/.test(base);
const comparison = event === 'pull_request' ? `${base}...${head}` : `${base}..${head}`;
const paths = (full ? [] : (await $`git diff --name-only -z ${comparison}`.text()).split('\0')).filter(
	name => name && !['.md', '.rst'].includes(extname(name).toLowerCase()) && !name.startsWith('docs/'),
);
const common = full || paths.some(name => name.startsWith('.github/'));
const bun = !['swift', 'empty'].includes(kind) && (common || paths.some(name => !name.startsWith('app-ios/')));
const swift =
	['swift', 'monorepo-swift'].includes(kind) &&
	(common ||
		paths.some(
			name =>
				kind === 'swift' ||
				['app-ios/', '.env', '.bun-version'].some(prefix => name.startsWith(prefix)) ||
				['package.json', 'bun.lock', 'bun.lockb'].includes(name),
		));

appendFileSync(output, `bun=${bun}\nswift=${swift}\n`);
