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
const isSwift = (name: string) => name === 'Package.swift' || name.startsWith('Sources/') || name.startsWith('Tests/');
const bun = kind !== 'empty' && (common || paths.some(name => !isSwift(name)));
const swift = common || paths.some(isSwift);

const spec = common || paths.some(name => name.startsWith('spec/') || name === 'scripts/spec.ts');
const web =
	common || paths.some(name => name.startsWith('packages/client-web/') || name.startsWith('packages/client/'));

appendFileSync(output, `bun=${bun}\nswift=${swift}\nspec=${spec}\nweb=${web}\n`);
