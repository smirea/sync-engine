/**
 * Runs the unit tests related to the files lefthook passes in: every `*.test.ts(x)` whose imports reach a changed
 * file, followed through the import graph. Imports resolve the way Bun resolves them, so tsconfig paths and
 * workspace packages count; anything that lands in node_modules does not.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = realpathSync(join(import.meta.dir, '..'));
const SOURCE = /\.(ts|tsx|mts)$/;
const TEST = /\.test\.tsx?$/;
const SKIP = new Set(['node_modules', 'dist', 'build', 'generated']);

const files = process.argv
	.slice(2)
	.flatMap(arg => arg.split(/\s+/))
	.filter(Boolean)
	.map(file => join(root, file));

function walk(dir: string, out: string[]) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path);
	}
	return out;
}

function resolveImport(from: string, specifier: string): string | null {
	try {
		const path = realpathSync(Bun.resolveSync(specifier, dirname(from)));
		return path.includes('/node_modules/') ? null : path;
	} catch {
		return null;
	}
}

const transpiler = new Bun.Transpiler({ loader: 'tsx' });
const importers = new Map<string, Set<string>>();
for (const file of walk(root, [])) {
	for (const { path } of transpiler.scanImports(readFileSync(file, 'utf8'))) {
		const target = resolveImport(file, path);
		if (target) importers.set(target, (importers.get(target) ?? new Set()).add(file));
	}
}

const seen = new Set(files.filter(file => SOURCE.test(file)));
const queue = [...seen];
for (let i = 0; i < queue.length; i++) {
	for (const importer of importers.get(queue[i]!) ?? []) {
		if (!seen.has(importer)) {
			seen.add(importer);
			queue.push(importer);
		}
	}
}

const selected = [...seen].filter(file => TEST.test(file) && existsSync(file));
if (selected.length > 0) {
	const result = spawnSync('bun', ['test', ...selected.toSorted()], { cwd: root, stdio: 'inherit' });
	process.exit(result.status ?? 1);
}
