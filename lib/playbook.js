import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_RELATIVE_PATH = path.join('.meeting-agent', 'ROTEIRO.md');
const DEFAULT_MAX_BYTES = 48 * 1024;

function unquote(value) {
  const trimmed = String(value ?? '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(source) {
  const match = String(source ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { attributes: {}, body: String(source ?? '') };
  const attributes = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = unquote(line.slice(separator + 1));
    attributes[key] = value;
  }
  return { attributes, body: String(source).slice(match[0].length) };
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (/^(true|sim|yes|1)$/i.test(String(value ?? '').trim())) return true;
  if (/^(false|não|nao|no|0)$/i.test(String(value ?? '').trim())) return false;
  return fallback;
}

export function loadPlaybook(
  projectPath,
  { relativePath = DEFAULT_RELATIVE_PATH, maxBytes = DEFAULT_MAX_BYTES } = {},
) {
  if (!projectPath) return null;
  const filePath = path.join(projectPath, relativePath);
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`roteiro inválido: ${filePath}`);
  if (stat.size > maxBytes) throw new Error(`roteiro excede ${maxBytes} bytes`);

  const source = fs.readFileSync(filePath, 'utf8');
  const { attributes, body } = parseFrontmatter(source);
  const text = body.trim();
  if (!text) throw new Error('roteiro vazio');
  return {
    path: filePath,
    profile: attributes.profile || path.basename(projectPath),
    liveAnalysis: parseBoolean(attributes.live_analysis, false),
    text,
  };
}

export { parseFrontmatter };
