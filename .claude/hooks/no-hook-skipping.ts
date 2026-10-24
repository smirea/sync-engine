// PreToolUse guard: agents skipped lefthook to get past failing checks instead of fixing them.
const { tool_input } = await Bun.stdin.json();
const command: string = tool_input?.command ?? '';

// A quoted single word is still an argument to git; only multi-word strings are messages.
const skips = command
	.replace(/"([^"\s\\]*)"|'([^'\s]*)'/g, '$1$2')
	.replace(/"(\\.|[^"\\])*"|'[^']*'/g, "''")
	.split(/&&|\|\||[;|\n]/)
	.map(segment => segment.trim())
	.filter(segment => /^(\w+=\S*\s+)*(git|gai)\b/.test(segment))
	.some(
		segment =>
			/\s--no-verify\b/.test(segment) ||
			/\bLEFTHOOK=(0|false)\b/.test(segment) ||
			/\bLEFTHOOK_(EXCLUDE|SKIP)=/.test(segment) ||
			/\bcore\.hooksPath\b/.test(segment) ||
			/^(\w+=\S*\s+)*git\b.*\scommit\b.*\s-[a-zA-Z]*n[a-zA-Z]*(\s|$)/.test(segment),
	);

if (skips) {
	console.error(
		'Git hooks must run. Fix the underlying failure in this PR or file a follow-up task; a flaky test is a bad test, so fix why it flakes instead of retrying.',
	);
	process.exit(2);
}
