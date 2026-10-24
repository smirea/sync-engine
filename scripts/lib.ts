/**
 * What the repository scripts share: a process runner, the dotenv reader, and the worktree list. No npm imports:
 * `setup-worktree` runs before `bun install`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Values = Record<string, string>;

type RunOptions = {
	/** Answer the output, or an empty string, instead of throwing when the command fails. */
	allowFail?: boolean;
	/** `pipe` captures both streams; `inherit-stderr` shows progress while capturing stdout; `inherit` shows both. */
	stdio?: 'pipe' | 'inherit-stderr' | 'inherit';
	env?: Values;
	cwd?: string;
};

/** Runs a command to completion and answers its trimmed stdout. A failure names the command and shows its output. */
export function run(cmd: string[], { allowFail = false, stdio = 'pipe', env, cwd }: RunOptions = {}): string {
	const result = spawnSync(cmd[0]!, cmd.slice(1), {
		encoding: 'utf8',
		cwd,
		env: env ? { ...process.env, ...env } : process.env,
		stdio: stdio === 'pipe' ? 'pipe' : stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'inherit'],
	});
	if (result.status !== 0) {
		if (allowFail) return '';
		throw new Error(`\`${cmd.join(' ')}\` failed\n${result.stderr ?? ''}${result.stdout ?? ''}`);
	}
	return (result.stdout ?? '').trim();
}

/** Empty values count as unset and are left out. */
export function parseDotenv(text: string): Values {
	const values: Values = {};
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		const [, key, rest] = match as unknown as [string, string, string];
		let value: string;
		const quote = rest[0];
		if ((quote === '"' || quote === "'") && rest.indexOf(quote, 1) > 0) {
			value = rest.slice(1, rest.indexOf(quote, 1));
		} else {
			value = rest.replace(/(^|\s+)#.*$/, '').trim();
		}
		if (value) values[key] = value;
	}
	return values;
}

/** A worktree's `.env.override`, which `setup-worktree` writes with its ports, or null without one. */
export function readOverride(worktree: string): Values | null {
	const file = join(worktree, '.env.override');
	return existsSync(file) ? parseDotenv(readFileSync(file, 'utf8')) : null;
}

export type Worktree = { path: string; branch?: string };

/** Every worktree of the repository `cwd` is in. Throws when `git` fails, so a bad checkout never reads as "none". */
export function worktrees(cwd: string): Worktree[] {
	return run(['git', '-C', cwd, 'worktree', 'list', '--porcelain'])
		.split('\n\n')
		.flatMap(block => {
			const path = block.match(/^worktree (.+)$/m)?.[1];
			const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
			return path ? [{ path, branch }] : [];
		});
}
