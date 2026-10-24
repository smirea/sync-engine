/**
 * Checks the protocol proofs under the Lean kernel: `bun scripts/spec.ts [--install]`.
 * `--install` fetches the pinned Bend release and Lean toolchain from `spec/toolchain.json` into
 * `$BEND_HOME` (default `~/.bend`) and `~/.elan` first, touching no shell profile. CI runs that form.
 */
import { $ } from 'bun';
import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { arch, env, exit, platform } from 'node:process';
import toolchain from '../spec/toolchain.json';

const root = join(import.meta.dir, '..');
const bendHome = env.BEND_HOME ?? join(homedir(), '.bend');
const elanBin = join(homedir(), '.elan', 'bin');
const bend = join(bendHome, 'bin', 'bend');
const bendVersion = `bend ${toolchain.bend}`;
const leanVersion = `Lean (version ${toolchain.lean.replace(/^v/, '')}`;
const run = { PATH: `${join(bendHome, 'bin')}:${elanBin}:${env.PATH}`, BEND_HOME: bendHome, BEND_NO_TELEMETRY: '1' };

const version = async (command: string[]) => {
	try {
		return (await $`${command}`.env(run).quiet().nothrow().text()).trim();
	} catch {
		return '';
	}
};

async function installBend() {
	const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null;
	const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
	if (!os || !cpu) throw new Error(`Bend has no build for ${platform}-${arch}`);
	const name = `bend-${toolchain.bend}-${os}-${cpu}.tar.gz`;
	const url = `https://github.com/bendlang/bend/releases/download/v${toolchain.bend}/${name}`;
	const tmp = mkdtempSync(join(tmpdir(), 'bend-'));
	console.log(`downloading ${url}`);
	await $`curl --proto =https --tlsv1.2 -fsSL -o ${join(tmp, name)} ${url}`;
	await $`tar -xzf ${join(tmp, name)} -C ${tmp}`;
	await $`mkdir -p ${join(bendHome, 'bin')}`;
	await $`rm -rf ${join(bendHome, 'bend2')} ${join(bendHome, 'guide')}`;
	await $`mv ${join(tmp, 'bend', 'bend2')} ${join(tmp, 'bend', 'guide')} ${bendHome}/`;
	await $`mv -f ${join(tmp, 'bend', 'bin', 'bend')} ${bend}`;
	await $`rm -rf ${tmp}`;
}

async function installLean() {
	const init = join(mkdtempSync(join(tmpdir(), 'elan-')), 'elan-init.sh');
	await $`curl --proto =https --tlsv1.2 -fsSL -o ${init} https://elan.lean-lang.org/elan-init.sh`;
	await $`sh ${init} -y --no-modify-path --default-toolchain leanprover/lean4:${toolchain.lean}`;
}

const install = Bun.argv.includes('--install');
if ((await version([bend, 'version'])) !== bendVersion) {
	if (!install) {
		console.error(`${bend} is not ${bendVersion}; run \`bun scripts/spec.ts --install\``);
		exit(1);
	}
	await installBend();
}
if (!(await version(['lean', '--version'])).startsWith(leanVersion)) {
	if (!install) {
		console.error(`lean ${toolchain.lean} not found on PATH or in ${elanBin}; run \`bun scripts/spec.ts --install\``);
		exit(1);
	}
	await installLean();
}
if (!existsSync(join(root, 'spec', 'PROOF.bend'))) throw new Error('spec/PROOF.bend is missing');

const result = await $`${bend} PROOF.bend --verdict`.cwd(join(root, 'spec')).env(run).nothrow();
exit(result.exitCode);
