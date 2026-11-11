import { runClaude } from './claude-client.js';
import config from './config.js';

export async function executeSkill(
  { skill, argumento },
  { projectPath, runFn = runClaude, timeoutMs = config.executorTimeoutMs },
) {
  const prompt = `Use a skill "${skill}" com este argumento: ${argumento ?? '(sem argumento)'}\nExecute a tarefa completamente e responda com um resumo conciso do resultado em português.`;
  return runFn(prompt, {
    cwd: projectPath,
    timeoutMs,
    extraArgs: ['--permission-mode', 'acceptEdits'],
  });
}
