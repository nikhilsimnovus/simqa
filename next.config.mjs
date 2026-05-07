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
};
export default nextConfig;
