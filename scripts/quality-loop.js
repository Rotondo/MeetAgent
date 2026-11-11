import { spawnSync } from 'node:child_process';
const rounds = Math.min(10, Math.max(1, Number(process.argv[2]) || 3));
for (let round = 1; round <= rounds; round++) {
  console.log(`Quality loop ${round}/${rounds}`);
  for (const args of [['--test'], ['scripts/evaluate-interventions.js']]) {
    const result = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
console.log('Deterministic regression loop passed. Human meeting utility still requires explicit ratings.');
