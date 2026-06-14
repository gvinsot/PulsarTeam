import fs from 'fs';
const r = JSON.parse(fs.readFileSync('.claude/refactor-survey.json', 'utf8'));
for (const p of r.confirmed) {
  console.log('[' + p.scope + '] (' + p.kind + '|' + p.risk + '|' + p.effort + ') ' + p.title);
}
console.log('--- rejected ---');
for (const p of r.rejected) console.log('REJ: ' + p.title);
