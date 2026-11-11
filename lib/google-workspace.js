import http from 'node:http';
import crypto from 'node:crypto';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

async function jsonRequest(url, options = {}, fetchFn = fetch) {
  const response = await fetchFn(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error_description || body?.error?.message || `Google HTTP ${response.status}`);
  return body;
}

export async function refreshGoogleToken(credentials, token, fetchFn = fetch) {
  if (!token?.refresh_token) throw new Error('Reconecte sua conta Google.');
  const body = new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret || '',
    refresh_token: token.refresh_token, grant_type: 'refresh_token' });
  const refreshed = await jsonRequest(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }, fetchFn);
  return { ...token, ...refreshed, expires_at: Date.now() + Number(refreshed.expires_in || 3600) * 1000 };
}

export async function validGoogleToken(credentials, token, { fetchFn = fetch, saveToken = () => {} } = {}) {
  if (!token?.access_token) throw new Error('Conta Google não conectada.');
  if ((token.expires_at || 0) > Date.now() + 60_000) return token;
  const refreshed = await refreshGoogleToken(credentials, token, fetchFn);
  saveToken(refreshed);
  return refreshed;
}

export async function authorizeGoogle(credentials, { openExternal, saveToken, timeoutMs = 180_000, fetchFn = fetch } = {}) {
  if (!credentials?.clientId) throw new Error('Informe o Client ID OAuth do Google.');
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(24));
  let server;
  const codePromise = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/oauth2/callback') { res.writeHead(404).end(); return; }
      if (url.searchParams.get('state') !== state) { res.writeHead(400).end('Estado inválido.'); reject(new Error('Estado OAuth inválido.')); return; }
      const error = url.searchParams.get('error');
      if (error) { res.writeHead(400).end('Autorização cancelada.'); reject(new Error(`Google OAuth: ${error}`)); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h2>Meeting Agent conectado.</h2><p>Você pode fechar esta janela.</p>');
      resolve(url.searchParams.get('code'));
    });
    server.listen(0, '127.0.0.1');
  });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/oauth2/callback`;
  const params = new URLSearchParams({ client_id: credentials.clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256' });
  await openExternal(`${AUTH_URL}?${params}`);
  let timer;
  try {
    const code = await Promise.race([codePromise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Tempo de conexão com Google esgotado.')), timeoutMs); })]);
    const body = new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret || '', code,
      code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri });
    const token = await jsonRequest(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }, fetchFn);
    const saved = { ...token, expires_at: Date.now() + Number(token.expires_in || 3600) * 1000 };
    saveToken(saved);
    return saved;
  } finally { clearTimeout(timer); server.close(); }
}

export async function listGoogleCalendarEvents({ credentials, token, days = 14, fetchFn = fetch, saveToken = () => {} }) {
  const active = await validGoogleToken(credentials, token, { fetchFn, saveToken });
  const timeMin = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const timeMax = new Date(Date.now() + days * 24 * 60 * 60_000).toISOString();
  const query = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '100' });
  const data = await jsonRequest(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${query}`, {
    headers: { authorization: `Bearer ${active.access_token}` },
  }, fetchFn);
  return (data.items || []).filter((item) => item.status !== 'cancelled').map((item) => ({
    externalId: item.id, source: 'google-calendar', title: item.summary || 'Evento sem título',
    description: item.description || '', start: item.start?.dateTime || item.start?.date || null,
    end: item.end?.dateTime || item.end?.date || null,
    participants: (item.attendees || []).map((person) => person.displayName || person.email).filter(Boolean),
    meetingUrl: item.hangoutLink || item.location || '', recurringEventId: item.recurringEventId || null,
  }));
}

export async function searchGoogleDrive({ credentials, token, query = '', fetchFn = fetch, saveToken = () => {}, limit = 8 }) {
  const active = await validGoogleToken(credentials, token, { fetchFn, saveToken });
  const safe = String(query).replace(/['\\]/g, ' ').trim();
  const q = safe ? `trashed = false and fullText contains '${safe.slice(0, 80)}'` : 'trashed = false';
  const params = new URLSearchParams({ q, pageSize: String(limit), orderBy: 'modifiedTime desc', fields: 'files(id,name,mimeType,modifiedTime,webViewLink,description)' });
  const data = await jsonRequest(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { authorization: `Bearer ${active.access_token}` } }, fetchFn);
  return (data.files || []).map((file) => ({ ...file, source: 'google-drive' }));
}

export async function readGoogleDriveText({ credentials, token, file, fetchFn = fetch, saveToken = () => {} }) {
  const active = await validGoogleToken(credentials, token, { fetchFn, saveToken });
  const exportable = file.mimeType === 'application/vnd.google-apps.document';
  const url = exportable
    ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=text%2Fplain`
    : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`;
  const response = await fetchFn(url, { headers: { authorization: `Bearer ${active.access_token}` } });
  if (!response.ok) throw new Error(`Drive HTTP ${response.status}`);
  return (await response.text()).slice(0, 20_000);
}
