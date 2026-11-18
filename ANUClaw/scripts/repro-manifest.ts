/**
 * Writes docs/evidence/repro-manifest.json: what the FULL image and its inputs are, as observed NOW (nothing is copied from older notes).
 *   npx tsx scripts/repro-manifest.ts [image=anuclaw-agent:latest]
 * GATK: the SHA-256 is a LOCAL CONSISTENCY CHECK (first download == the bytes in the image). GATK publishes no checksum, so this is NOT publisher-authenticated integrity.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const image = process.argv[2] ?? 'anuclaw-agent:latest';
const root = path.resolve(__dirname, '..');
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex');
const sh = (cmd: string[], input?: string) => spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', input, maxBuffer: 1 << 26 });
const inImage = (script: string) => { const r = sh(['docker', 'run', '--rm', '--user', `${process.getuid!()}:${process.getgid!()}`, '--tmpfs', '/tmp:rw,exec,mode=1777', '-e', 'HOME=/tmp', '-e', 'USER=anuclaw', '--entrypoint', 'bash', image, '-c', `cd /tmp; ${script}`]); return { status: r.status, out: (r.stdout + r.stderr).trim().split('\n').slice(0, 3).join(' | ').slice(0, 200) }; };
const insp = JSON.parse(sh(['docker', 'image', 'inspect', image]).stdout)[0];
const tools: Record<string, string> = {
  samtools: 'samtools --version | head -1', bedtools: 'bedtools --version', blastn: 'blastn -version | head -1', bwa: 'bwa 2>&1 | grep -i version', minimap2: 'minimap2 --version', fastqc: 'fastqc --version',
  bcftools: 'bcftools --version | head -1', gatk: 'gatk --version 2>&1 | grep -a "Genome Analysis Toolkit"', vina: 'vina --version 2>&1 | head -1', obabel: 'obabel -V', snakemake: 'snakemake --version',
  nextflow: 'NO_COLOR=1 nextflow -version 2>&1 | grep -a "version" | head -1', java: 'java -version 2>&1 | head -1', python: 'python --version', node: 'node --version',
  claude: 'claude --version', rdkit: 'python -c "import rdkit; print(rdkit.__version__)"', torch: 'python -c "import torch; print(torch.__version__)"',
};
const toolVersions = Object.fromEntries(Object.entries(tools).map(([k, c]) => [k, inImage(c)]));
const gatkInImage = inImage('sha256sum /opt/gatk-4.5.0.0/gatk-package-4.5.0.0-local.jar | cut -d" " -f1');
const fixtures: Record<string, string> = {};
for (const f of fs.readdirSync(path.join(root, 'docs/evidence/live-artifacts'))) fixtures[`docs/evidence/live-artifacts/${f}`] = sha(`docs/evidence/live-artifacts/${f}`);
for (const f of ['src/validation/validation-vectors.json', 'src/research/scipy-vectors.json', 'container/contract/fake-claude.js']) if (fs.existsSync(path.join(root, f))) fixtures[f] = sha(f);
const pins = sh(['git', '-C', root, 'rev-parse', 'HEAD']).stdout.trim();
const manifest = {
  generatedAt: new Date().toISOString(),
  image: { ref: image, id: insp.Id, repoDigests: insp.RepoDigests, digestNote: insp.RepoDigests?.length ? undefined : 'No registry digest: the image was built locally and never pushed. The image ID (config digest) is the identity.',
    architecture: `${insp.Os}/${insp.Architecture}`, created: insp.Created, sizeBytes: insp.Size, baseImage: 'ubuntu:24.04 (tag, not digest-pinned)' },
  dependencyInputs: {
    'container/Dockerfile': sha('container/Dockerfile'), 'container/python/core.in': sha('container/python/core.in'), 'container/python/core.lock.txt': sha('container/python/core.lock.txt'),
    'container/python/optional.in': sha('container/python/optional.in'), 'container/entrypoint.js': sha('container/entrypoint.js'), 'scripts/lock-container-python.sh': sha('scripts/lock-container-python.sh'),
    lockedDistributions: fs.readFileSync(path.join(root, 'container/python/core.lock.txt'), 'utf8').split('\n').filter((l) => l.includes('==')).length,
    lockMode: 'wheels only, --require-hashes; resolved inside python:3.12-slim linux/arm64 (python:3.12-slim tag not digest-pinned); torch from the PyTorch CPU index; snakemake in its own venv (NOT hash-locked)',
  },
  gatk: { version: '4.5.0.0', localZipSha256: fs.readFileSync(path.join(root, 'container/vendor/gatk-4.5.0.0.zip.sha256'), 'utf8').split(/\s+/)[0], jarSha256InImage: gatkInImage.out,
    status: 'LOCAL CONSISTENCY CHECK ONLY (the bytes first downloaded are the bytes installed). GATK publishes no checksum; this is NOT publisher-authenticated integrity.' },
  toolVersions, fixtureHashes: fixtures, sourceRevision: { gitHeadOfOuterRepo: pins, note: 'ANUClaw is untracked in the outer repository; the hashes above, not this commit, pin the inputs.' },
};
fs.writeFileSync(path.join(root, 'docs/evidence/repro-manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
const bad = Object.entries(toolVersions).filter(([, v]) => v.status !== 0).map(([k]) => k);
console.log(`image ${insp.Id.slice(0, 19)} ${manifest.image.architecture}; ${Object.keys(toolVersions).length} tools queried; failed: ${bad.join(', ') || 'none'}`);
