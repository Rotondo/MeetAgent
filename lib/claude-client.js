import { spawn } from 'node:child_process';
import config from './config.js';

// rawArgs=true: usa apenas cmd+extraArgs (testes). rawArgs=false: monta CLI real do claude.
export function runClaude(prompt, opts = {}) {
  const {
    cwd, timeoutMs = config.executorTimeoutMs, model, cmd = config.claudeCmd,
    extraArgs = [], rawArgs = false,
  } = opts;
  const args = rawArgs ? extraArgs : ['-p', ...(model ? ['--model', model] : []), ...extraArgs];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: !rawArgs, windowsHide: true });
    let stdout = '', stderr = '', done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGKILL');
      reject(new Error('timeout'));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => { if (!done) { done = true; clearTimeout(timer); reject(err); } });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`exit ${code}: ${stderr.slice(0, 500)}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/```(?:json)?/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}
