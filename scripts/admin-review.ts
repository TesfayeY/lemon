/**
 * Local reviewer CLI for the staff API (no admin UI yet; see
 * docs/features/admin-moderation.md). Every action goes through /v1/admin, so
 * the server checks the staff claim, compare-and-sets and writes the audit log.
 *
 * Auth: set ADMIN_ID_TOKEN, or LEMON_STAFF_EMAIL + LEMON_STAFF_PASSWORD to sign
 * in against the Auth emulator at FIREBASE_AUTH_EMULATOR_HOST. API base URL:
 * LEMON_API_URL (default http://localhost:3000).
 *
 *   npx tsx ../../scripts/admin-review.ts whoami | reasons
 *   npx tsx ../../scripts/admin-review.ts photos [--cursor <c>]
 *   npx tsx ../../scripts/admin-review.ts photo <id> [--save <file.webp>]
 *   npx tsx ../../scripts/admin-review.ts approve-photo <id> [--note <text>]
 *   npx tsx ../../scripts/admin-review.ts reject-photo <id> --reason <code> [--note <text>]
 *   npx tsx ../../scripts/admin-review.ts prompts [--cursor <c>]
 *   npx tsx ../../scripts/admin-review.ts prompt <id>
 *   npx tsx ../../scripts/admin-review.ts approve-prompt <id> --revision <n> [--note <text>]
 *   npx tsx ../../scripts/admin-review.ts reject-prompt <id> --revision <n> --reason <code> [--note <text>]
 *   npx tsx ../../scripts/admin-review.ts user <id>
 *   npx tsx ../../scripts/admin-review.ts suspend <id> --reason <code> [--note <text>]
 *   npx tsx ../../scripts/admin-review.ts restore <id> --reason <code> [--note <text>]
 *   npx tsx ../../scripts/admin-review.ts audit <photo|promptAnswer|user> <id>
 */

import { writeFile } from 'node:fs/promises';

const API = (process.env['LEMON_API_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function idToken(): Promise<string> {
  const token = process.env['ADMIN_ID_TOKEN'];
  if (token) return token;
  const email = process.env['LEMON_STAFF_EMAIL'];
  const password = process.env['LEMON_STAFF_PASSWORD'];
  const emulator = process.env['FIREBASE_AUTH_EMULATOR_HOST'];
  if (!email || !password || !emulator) {
    throw new Error('Set ADMIN_ID_TOKEN, or LEMON_STAFF_EMAIL, LEMON_STAFF_PASSWORD and FIREBASE_AUTH_EMULATOR_HOST');
  }
  // The emulator accepts any API key; this never reaches a real project
  const res = await fetch(`http://${emulator}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const body = await res.json() as { idToken?: string; error?: { message: string } };
  if (!body.idToken) throw new Error(`Emulator sign-in failed: ${body.error?.message ?? res.status}`);
  return body.idToken;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const [arg1, arg2] = rest;
  const token = await idToken();

  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json() as { data?: unknown; meta?: unknown; error?: unknown };
    if (!res.ok) {
      console.error(`HTTP ${res.status}`, JSON.stringify(json.error, null, 2));
      process.exitCode = 1;
      return null;
    }
    console.log(JSON.stringify({ data: json.data, meta: json.meta }, null, 2));
    return json.data;
  };
  const page = (path: string) => {
    const cursor = option(rest, 'cursor');
    return call('GET', cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path);
  };
  const note = option(rest, 'note') ?? null;
  const need = (value: string | undefined, what: string) => {
    if (!value) throw new Error(`${what} is required`);
    return encodeURIComponent(value);
  };

  switch (command) {
    case 'whoami': await call('GET', '/v1/admin/me'); break;
    case 'reasons': await call('GET', '/v1/admin/reasons'); break;
    case 'photos': await page('/v1/admin/content/photos'); break;
    case 'photo': {
      const id = need(arg1, 'photo id');
      await call('GET', `/v1/admin/content/photos/${id}`);
      const save = option(rest, 'save');
      if (save) {
        const res = await fetch(`${API}/v1/admin/content/photos/${id}/media/display`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`Media download failed: HTTP ${res.status}`);
        await writeFile(save, Buffer.from(await res.arrayBuffer()));
        console.log(`Saved display variant to ${save}`);
      }
      break;
    }
    case 'approve-photo':
      await call('POST', `/v1/admin/content/photos/${need(arg1, 'photo id')}/review`, { decision: 'approve', note });
      break;
    case 'reject-photo':
      await call('POST', `/v1/admin/content/photos/${need(arg1, 'photo id')}/review`, { decision: 'reject', reason: required(rest, 'reason'), note });
      break;
    case 'prompts': await page('/v1/admin/content/prompt-answers'); break;
    case 'prompt': await call('GET', `/v1/admin/content/prompt-answers/${need(arg1, 'answer id')}`); break;
    case 'approve-prompt':
      await call('POST', `/v1/admin/content/prompt-answers/${need(arg1, 'answer id')}/review`, {
        decision: 'approve', expectedRevision: Number(required(rest, 'revision')), note,
      });
      break;
    case 'reject-prompt':
      await call('POST', `/v1/admin/content/prompt-answers/${need(arg1, 'answer id')}/review`, {
        decision: 'reject', reason: required(rest, 'reason'), expectedRevision: Number(required(rest, 'revision')), note,
      });
      break;
    case 'user': await call('GET', `/v1/admin/users/${need(arg1, 'user id')}`); break;
    case 'suspend':
    case 'restore':
      await call('POST', `/v1/admin/users/${need(arg1, 'user id')}/${command}`, { reason: required(rest, 'reason'), note });
      break;
    case 'audit':
      await call('GET', `/v1/admin/audit-log?targetType=${need(arg1, 'target type')}&targetId=${need(arg2, 'target id')}`);
      break;
    default:
      console.error('Unknown command. See the usage at the top of scripts/admin-review.ts.');
      process.exitCode = 1;
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
