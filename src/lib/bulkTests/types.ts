// Local types for the bulk-tests module. Kept separate so generator.ts /
// validator.ts don't pull the full @/lib/inventory tree through a circular
// `import type` and so this module is consumable from API routes without
// going through the full apiTester surface.

export interface UesimApiOpts {
  systemId: string;
  host: string;
  username: string;
  password: string;
}
