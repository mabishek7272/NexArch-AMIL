/**
 * Fail-closed environment loader for the NexArch e2e suite. No credential — bootstrap or
 * otherwise — is ever hardcoded here or anywhere else in this suite. If the required
 * environment variables are not set, every entry point that calls this (the Playwright
 * config itself, and global-setup) throws immediately, so an unconfigured run fails loudly
 * instead of silently reporting zero tests as a false "pass".
 */
const REQUIRED = ['NEXARCH_QA_BASE_URL', 'NEXARCH_QA_API_URL', 'NEXARCH_QA_EMAIL', 'NEXARCH_QA_PASSWORD'] as const;

export interface NexArchQaEnv {
  BASE_URL: string;
  API_URL: string;
  EMAIL: string;
  PASSWORD: string;
}

export function requireNexArchQaEnv(): NexArchQaEnv {
  const missing = REQUIRED.filter((key) => !process.env[key]?.trim());
  if (missing.length) {
    throw new Error(
      `NexArch QA suite requires ${missing.join('/')} — see dashboard/e2e/README.md. ` +
      'Refusing to run with test credentials unset rather than silently skipping.',
    );
  }
  return {
    BASE_URL: process.env.NEXARCH_QA_BASE_URL!,
    API_URL: process.env.NEXARCH_QA_API_URL!,
    EMAIL: process.env.NEXARCH_QA_EMAIL!,
    PASSWORD: process.env.NEXARCH_QA_PASSWORD!,
  };
}
