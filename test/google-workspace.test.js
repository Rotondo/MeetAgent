import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listGoogleCalendarEvents, searchGoogleDrive } from '../lib/google-workspace.js';

const token = { access_token: 'token', expires_at: Date.now() + 3_600_000 };

test('Google Calendar normaliza eventos e participantes', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ items: [{ id: 'evt-1', summary: 'Mesa de performance',
    start: { dateTime: '2026-09-17T11:00:00-03:00' }, end: { dateTime: '2026-09-17T12:00:00-03:00' },
    attendees: [{ displayName: 'Ruan' }, { email: 'andre@example.com' }], hangoutLink: 'https://meet.google.com/x' }] }) });
  const events = await listGoogleCalendarEvents({ credentials: { clientId: 'x' }, token, fetchFn });
  assert.equal(events[0].source, 'google-calendar');
  assert.deepEqual(events[0].participants, ['Ruan', 'andre@example.com']);
  assert.equal(events[0].meetingUrl, 'https://meet.google.com/x');
});

test('Google Drive retorna metadados rastreáveis', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ files: [{ id: 'doc-1', name: 'Plano checkout', mimeType: 'text/plain' }] }) });
  const files = await searchGoogleDrive({ credentials: { clientId: 'x' }, token, query: 'checkout', fetchFn });
  assert.equal(files[0].source, 'google-drive');
  assert.equal(files[0].name, 'Plano checkout');
});
