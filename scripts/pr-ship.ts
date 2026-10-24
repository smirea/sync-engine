/**
 * Drives the current branch's open PR to a verdict: `bun scripts/pr-ship.ts [--merge] [--budget seconds]`.
 * Waits for CI, then exits with what to do next. It stops before its budget (default 540s,
 * under the 600s tool limit), so rerun it in the foreground until it exits 0; never end the turn while a PR waits.
 *
 *   0  ready, or merged with --merge
 *   1  something to fix: failing checks or unresolved review threads (printed)
 *   2  conflicts with the base branch: rebase onto it, push, rerun
 *   3  budget spent while checks still run: rerun
 */
import { parseArgs } from 'node:util';
import { run } from './lib';

const { values } = parseArgs({
	options: { merge: { type: 'boolean' }, budget: { type: 'string', default: '540' } },
});
const budget = Number(values.budget);
if (!Number.isFinite(budget) || budget <= 0)
	throw new Error(`--budget must be a number of seconds, not "${values.budget}"`);
const deadline = Date.now() + budget * 1000;
const POLL_MS = 20_000;

type Check = {
	__typename: string;
	name?: string;
	context?: string;
	status?: string;
	conclusion?: string;
	state?: string;
	detailsUrl?: string;
	targetUrl?: string;
};
type Pr = {
	number: number;
	url: string;
	state: string;
	headRefOid: string;
	baseRefName: string;
	mergeable: string;
	statusCheckRollup: Check[];
};

// The last line names the code, so a `| tail` that swallows the exit status still shows it.
function exit(code: number, message: string): never {
	console.log(`${message}\npr-ship exit ${code}`);
	process.exit(code);
}

const head = run(['git', 'rev-parse', 'HEAD']);
const [owner, repo] = run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).split('/');

function view(): Pr {
	try {
		return JSON.parse(
			run(['gh', 'pr', 'view', '--json', 'number,url,state,headRefOid,baseRefName,mergeable,statusCheckRollup']),
		);
	} catch (error) {
		if (error instanceof Error && error.message.includes('no pull requests found')) {
			exit(1, 'This branch has no PR. Push it and open one with `gh pr create`, then rerun.');
		}
		throw error;
	}
}

function checks(pr: Pr) {
	const all = pr.statusCheckRollup.map(check => ({
		name: check.name ?? check.context ?? '?',
		done: check.__typename === 'StatusContext' ? check.state !== 'PENDING' : check.status === 'COMPLETED',
		ok: ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.conclusion ?? check.state ?? ''),
		url: check.detailsUrl ?? check.targetUrl ?? '',
	}));
	return { all, failed: all.filter(check => check.done && !check.ok), pending: all.filter(check => !check.done) };
}

function unresolvedThreads(number: number) {
	const query = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved path line comments(first:1){nodes{author{login} body url}}}}}}}`;
	const data = JSON.parse(
		run([
			'gh',
			'api',
			'graphql',
			'-f',
			`query=${query}`,
			'-F',
			`owner=${owner}`,
			'-F',
			`repo=${repo}`,
			'-F',
			`number=${number}`,
		]),
	);
	type Thread = {
		isResolved: boolean;
		path: string;
		line: number | null;
		comments: { nodes: { author: { login: string }; body: string; url: string }[] };
	};
	return (data.data.repository.pullRequest.reviewThreads.nodes as Thread[])
		.filter(thread => !thread.isResolved)
		.map(thread => {
			const comment = thread.comments.nodes[0]!;
			return `- ${thread.path}:${thread.line ?? '?'} (${comment.author.login}) ${comment.body.split('\n')[0]!.slice(0, 200)}\n  ${comment.url}`;
		});
}

while (true) {
	const pr = view();
	if (pr.state === 'MERGED') exit(0, `Merged: ${pr.url}`);
	if (pr.state === 'CLOSED') exit(1, `${pr.url} is closed.`);
	if (pr.headRefOid !== head)
		exit(1, `The PR head is ${pr.headRefOid.slice(0, 7)} but HEAD is ${head.slice(0, 7)}. Push, then rerun.`);
	if (pr.mergeable === 'CONFLICTING') {
		exit(
			2,
			`${pr.url} conflicts with ${pr.baseRefName}, so CI will not run. Rebase onto origin/${pr.baseRefName}, push, rerun.`,
		);
	}

	const { all, failed, pending } = checks(pr);
	if (failed.length) {
		exit(
			1,
			`Failing checks:\n${failed.map(check => `- ${check.name} ${check.url}`).join('\n')}\nRead logs with \`gh run view <run id> --log-failed\`, fix the cause, push, rerun.`,
		);
	}
	const threads = unresolvedThreads(pr.number);
	if (threads.length) {
		exit(1, `Unresolved review threads:\n${threads.join('\n')}\nFix or answer each, resolve the thread, push, rerun.`);
	}

	const waiting = [...(all.length ? [] : ['checks to start']), ...pending.map(check => check.name)];
	if (!waiting.length && pr.mergeable === 'MERGEABLE') {
		if (!values.merge) exit(0, `Ready to merge: ${pr.url}`);
		run(['gh', 'pr', 'merge', String(pr.number), '--merge']);
		continue;
	}
	if (!waiting.length) waiting.push('GitHub to compute mergeability');
	if (Date.now() + POLL_MS > deadline) {
		exit(3, `Still waiting on ${waiting.join(', ')}. Rerun.`);
	}
	console.log(`Waiting on ${waiting.join(', ')}…`);
	await Bun.sleep(POLL_MS);
}
