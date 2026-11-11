import { spawn } from 'node:child_process';
import electronPath from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(fileURLToPath(import.meta.url));

const idx = process.argv.indexOf('--project');
const projArg = idx !== -1 && process.argv[idx + 1]
  ? `--project=${process.argv[idx + 1]}`
  : process.argv.find((a) => a.startsWith('--project=')) ?? '';
const forwardedArgs = [];
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--project') {
    i += 1;
    continue;
  }
  if (arg.startsWith('--project=')) continue;
  forwardedArgs.push(arg);
}
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
if (childEnv.NODE_TLS_REJECT_UNAUTHORIZED === '0') delete childEnv.NODE_TLS_REJECT_UNAUTHORIZED;
spawn(electronPath, ['.', projArg, ...forwardedArgs].filter(Boolean), {
  cwd: appDir,
  env: childEnv,
  stdio: 'inherit',
  shell: false,
});
