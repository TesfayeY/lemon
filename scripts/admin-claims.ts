/**
 * Grant, revoke or show the `staffRole` custom claim on a Firebase Auth
 * EMULATOR account. Development only: refuses to run in production or
 * without FIREBASE_AUTH_EMULATOR_HOST, so it can never touch a real project.
 *
 * Run from apps/api:
 *   npx tsx --env-file=.env ../../scripts/admin-claims.ts grant <email> <moderator|admin> [--create]
 *   npx tsx --env-file=.env ../../scripts/admin-claims.ts revoke <email>
 *   npx tsx --env-file=.env ../../scripts/admin-claims.ts show <email>
 *
 * --create makes a fictional emulator account if none exists, using the
 * password in LEMON_STAFF_PASSWORD (kept out of shell history and argv).
 * Granting marks the emulator account's email verified, which staff routes require.
 * Revoking also revokes refresh tokens, so tokens that still carry the old
 * claim are rejected by the API's revocation check.
 *
 * The claim takes effect on the staff member's next ID token (sign in again).
 */

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  // Dynamic imports: scripts/ has no package.json, so this file may load as CommonJS
  const { loadConfig } = await import('../apps/api/src/config.js');
  const { initFirebase, getAuth } = await import('../apps/api/src/firebase.js');
  const { STAFF_ROLE_CLAIM, STAFF_ROLES, isStaffRole } = await import('../apps/api/src/modules/admin/roles.js');

  const USAGE = `Usage:
  admin-claims.ts grant <email> <${STAFF_ROLES.join('|')}> [--create]
  admin-claims.ts revoke <email>
  admin-claims.ts show <email>`;

  const [command, email, role, ...flags] = process.argv.slice(2);
  if (!command || !email) fail(USAGE);

  const config = loadConfig();
  if (config.NODE_ENV === 'production') fail('admin-claims.ts is a development tool and refuses to run in production.');
  if (!config.FIREBASE_AUTH_EMULATOR_HOST) {
    fail('FIREBASE_AUTH_EMULATOR_HOST is not set; refusing to change claims outside the Auth emulator.');
  }

  const auth = getAuth(initFirebase(config));
  const findUser = async () => {
    try {
      return await auth.getUserByEmail(email);
    } catch (err) {
      if ((err as { code?: string }).code === 'auth/user-not-found') return null;
      throw err;
    }
  };

  if (command === 'show') {
    const user = await findUser();
    if (!user) fail(`No emulator account for ${email}.`);
    console.log(`${email}: ${STAFF_ROLE_CLAIM}=${String(user.customClaims?.[STAFF_ROLE_CLAIM] ?? '(none)')} emailVerified=${user.emailVerified}`);
    return;
  }

  if (command === 'grant') {
    if (!isStaffRole(role)) fail(`Role must be one of: ${STAFF_ROLES.join(', ')}\n\n${USAGE}`);
    let user = await findUser();
    if (!user) {
      if (!flags.includes('--create')) fail(`No emulator account for ${email}. Pass --create to make one.`);
      const password = process.env['LEMON_STAFF_PASSWORD'];
      if (!password || password.length < 8) fail('Set LEMON_STAFF_PASSWORD (8+ characters) to create the account.');
      user = await auth.createUser({ email, password, emailVerified: true, displayName: `Local ${role}` });
      console.log(`Created emulator account ${email}.`);
    }
    await auth.setCustomUserClaims(user.uid, { ...(user.customClaims ?? {}), [STAFF_ROLE_CLAIM]: role });
    if (!user.emailVerified) await auth.updateUser(user.uid, { emailVerified: true });
    console.log(`Granted ${STAFF_ROLE_CLAIM}=${role} to ${email}. Sign in again to get a token with the claim.`);
    return;
  }

  if (command === 'revoke') {
    const user = await findUser();
    if (!user) fail(`No emulator account for ${email}.`);
    const claims = { ...(user.customClaims ?? {}) };
    delete claims[STAFF_ROLE_CLAIM];
    await auth.setCustomUserClaims(user.uid, claims);
    await auth.revokeRefreshTokens(user.uid);
    console.log(`Revoked ${STAFF_ROLE_CLAIM} from ${email} and revoked their existing sessions.`);
    return;
  }

  fail(USAGE);
}

main().catch((err: Error & { code?: string }) => {
  console.error(err.code ? `${err.code}: ${err.message}` : err.message);
  process.exit(1);
});
