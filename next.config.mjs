/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The cfg templates in src/cfgTemplates/ are read at runtime via fs.readFileSync.
  // Tell Next.js they're server-only assets to bundle properly in standalone builds.
  outputFileTracingIncludes: {
    '/api/testcases/[id]/preview': ['./src/cfgTemplates/**'],
    '/api/runs/[id]':              ['./src/cfgTemplates/**'],
    '/api/runs':                   ['./src/cfgTemplates/**'],
  },
  // Packages with native .node addons that Next.js MUST NOT webpack-bundle.
  // ssh2 (transitively pulled in by node-ssh, used by src/lib/labTools.ts for
  // the Tools → UE-sim cfg patcher) ships a sshcrypto.node binary that Next's
  // default loader can't parse. Listing it here makes Next leave it alone and
  // require() it at runtime from node_modules. playwright has the same issue.
  serverExternalPackages: ['ssh2', 'node-ssh', 'playwright', 'playwright-core'],
};
export default nextConfig;
