/** The four NexArch routes under test. Research Studio's path is built lazily (not at
 * module-load) because the fixture project id is only known after global-setup runs. */
export function nexArchRoutes(): Array<{ name: string; path: string }> {
  const projectId = process.env.NEXARCH_QA_PROJECT_ID;
  if (!projectId) {
    throw new Error('NEXARCH_QA_PROJECT_ID is not set — global-setup should have created the SYNTHETIC fixture project before any test runs.');
  }
  return [
    { name: 'overview', path: '/nexarch' },
    { name: 'research-studio', path: `/nexarch/research-studio?project=${projectId}` },
    { name: 'connections', path: '/nexarch/connections' },
    { name: 'style-guide', path: '/nexarch/style-guide' },
  ];
}
