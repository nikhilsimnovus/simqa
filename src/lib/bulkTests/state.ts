// Single-process in-memory state for the bulk-tests pipeline. The dev
// server is a single Node process so this is fine; if we ever go
// multi-process we'd swap this for Redis or the file-backed manifest.
//
// The manifest is also persisted to disk on every generation finish so a
// process restart doesn't lose the list of created testcases (and so a
// human can read it).

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GenerationProgress, GenerationResult } from './generator';
import type { ValidationProgress, ValidationSummary } from './validator';
import type { UiValidationProgress, UiValidationSummary } from './uiValidator';

export interface RunHandle {
  abort: AbortController;
}

interface BulkState {
  generation: {
    progress?: GenerationProgress;
    result?: GenerationResult;
    handle?: RunHandle;
  };
  validation: {
    progress?: ValidationProgress;
    result?: ValidationSummary;
    handle?: RunHandle;
  };
  uiValidation: {
    progress?: UiValidationProgress;
    result?: UiValidationSummary;
    handle?: RunHandle;
  };
  /** Last manifest written to disk (in-memory snapshot). */
  manifestPath?: string;
}

const STATE: BulkState = {
  generation: {},
  validation: {},
  uiValidation: {},
};

export function getState(): BulkState { return STATE; }

export function manifestDir(): string {
  return path.join(process.cwd(), 'data', 'bulk-tests');
}

export function manifestFile(): string {
  return path.join(manifestDir(), 'manifest.json');
}

export function writeManifest(result: GenerationResult): void {
  fs.mkdirSync(manifestDir(), { recursive: true });
  fs.writeFileSync(manifestFile(), JSON.stringify(result, null, 2));
  STATE.manifestPath = manifestFile();
}

export function readManifest(): GenerationResult | null {
  try {
    const text = fs.readFileSync(manifestFile(), 'utf8');
    return JSON.parse(text) as GenerationResult;
  } catch {
    return null;
  }
}

export function writeValidationSummary(summary: ValidationSummary): void {
  fs.mkdirSync(manifestDir(), { recursive: true });
  const file = path.join(manifestDir(), `validation-${summary.finishedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(summary, null, 2));
}
