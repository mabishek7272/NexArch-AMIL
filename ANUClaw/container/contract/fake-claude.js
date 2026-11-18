#!/usr/bin/env node
/** TEST DOUBLE for the agent CLI (contract tests only). It makes NO model call; it reports what the container gives it. */
'use strict';
const fs = require('fs'); const crypto = require('crypto');
const prompt = process.argv[process.argv.indexOf('-p') + 1] || '';
const out = (o) => process.stdout.write(JSON.stringify(o));
const has = (k) => Object.prototype.hasOwnProperty.call(process.env, k);
if (prompt.includes('MODE:ENV')) out({ uid: process.getuid(), apiKeyPresent: has('ANTHROPIC_API_KEY'), baseUrlPresent: has('ANTHROPIC_BASE_URL'), envNames: Object.keys(process.env).sort(), argvHasKey: process.argv.join(' ').includes(process.env.ANTHROPIC_API_KEY || '\u0000none') });
else if (prompt.includes('MODE:WRITE')) { fs.writeFileSync('/workspace/output/result.txt', 'artifact from the container'); out({ wrote: true }); }
else if (prompt.includes('MODE:MEDIA')) { const p = prompt.match(/\/workspace\/media\/\S+/)[0].replace(/\]$/, ''); out({ media: p, sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'), writable: (() => { try { fs.writeFileSync(p, 'x'); return true; } catch { return false; } })() }); }
else if (prompt.includes('MODE:SKILLS')) { let w = true; try { fs.writeFileSync('/workspace/skills/x', 'x'); } catch { w = false; } out({ skills: fs.readdirSync('/workspace/skills').length > 0, skillsWritable: w }); }
else if (prompt.includes('MODE:TOOL')) { const { spawnSync } = require('child_process'); const r = spawnSync(process.env.CONTRACT_TOOL || 'definitely-not-installed-tool', ['--version'], { encoding: 'utf8' }); out({ toolAvailable: r.status === 0, error: r.error ? r.error.code : null }); }
else if (prompt.includes('MODE:JOB')) { // a scripted JOB standing in for the agent's tool use: runs REAL tools from the image on tiny fixtures, writes a result artifact
  const { spawnSync } = require('child_process'); const sh = (c) => spawnSync('bash', ['-c', c], { encoding: 'utf8', cwd: '/tmp' });
  const sam = sh("printf '@HD\\tVN:1.6\\n@SQ\\tSN:chr1\\tLN:100\\nr1\\t0\\tchr1\\t1\\t60\\t4M\\t*\\t0\\t0\\tACGT\\tIIII\\nr2\\t16\\tchr1\\t10\\t60\\t4M\\t*\\t0\\t0\\tTTTT\\tIIII\\n' > t.sam; samtools view -b t.sam > t.bam; samtools view -c -F 4 t.bam");
  const rd = sh("python -c \"from rdkit import Chem; from rdkit.Chem import Descriptors; print(round(Descriptors.MolWt(Chem.MolFromSmiles('CC(=O)Oc1ccccc1C(=O)O')),2))\"");
  const result = { tool: 'samtools+rdkit', mappedReads: Number(sam.stdout.trim()), aspirinMolWt: Number(rd.stdout.trim()), status: [sam.status, rd.status] };
  fs.writeFileSync('/workspace/output/job.json', JSON.stringify(result)); out(result); }
else if (prompt.includes('MODE:SLEEP')) setTimeout(() => out({ slept: true }), 60_000);
else if (prompt.includes('MODE:FAIL')) { process.stderr.write('agent crashed (test double)\n'); process.exit(3); }
else out({ echoPrompt: prompt.slice(0, 200), model: process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : null });
