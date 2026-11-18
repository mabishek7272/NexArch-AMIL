/**
 * Credentials for the live dashboard smoke scripts. There are no built-in
 * defaults: supply an account you created yourself (e.g. the bootstrap admin).
 *
 *   ANUCLAW_SMOKE_EMAIL=... ANUCLAW_SMOKE_PASSWORD=... npx tsx scripts/elab-mfa-smoke.ts
 */
export function smokeCredentials(): { email: string; password: string } {
  const email = process.env.ANUCLAW_SMOKE_EMAIL?.trim();
  const password = process.env.ANUCLAW_SMOKE_PASSWORD;
  if (!email || !password) {
    console.error('Set ANUCLAW_SMOKE_EMAIL and ANUCLAW_SMOKE_PASSWORD (a local test account) to run this smoke script.');
    process.exit(2);
  }
  return { email, password };
}
