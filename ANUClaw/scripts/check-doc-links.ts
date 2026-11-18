/** Checks that every relative markdown link in README.md, docs/** and validation/** (markdown) points at an existing file (anchors ignored; http(s)/mailto skipped). */
import * as fs from 'fs';
import * as path from 'path';
const root = path.resolve(__dirname, '..');
const mdIn = (d: string): string[] => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === 'evidence' ? [] : mdIn(path.join(d, e.name))) : e.name.endsWith('.md') ? [path.join(d, e.name)] : []) : [];
const files = [path.join(root, 'README.md'), ...mdIn(path.join(root, 'docs')), ...mdIn(path.join(root, 'validation'))].filter(fs.existsSync);
let bad = 0, n = 0;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const t = m[1]; if (/^(https?:|mailto:|#)/.test(t)) continue; n++;
    const target = path.resolve(path.dirname(f), decodeURIComponent(t.split('#')[0]));
    if (!fs.existsSync(target)) { bad++; console.log(`BROKEN ${path.relative(root, f)} → ${t}`); }
  }
}
console.log(`${files.length} files, ${n} relative links, ${bad} broken`);
process.exit(bad ? 1 : 0);
