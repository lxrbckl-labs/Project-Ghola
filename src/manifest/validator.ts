import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import schema from './schema.json';
import type { ModuleManifest } from './types';

export type ValidationResult =
  | { ok: true; manifest: ModuleManifest }
  | { ok: false; errors: string[] };

let cachedValidator: ValidateFunction | undefined;

function getValidator(): ValidateFunction {
  if (!cachedValidator) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    cachedValidator = ajv.compile(schema);
  }
  return cachedValidator;
}

function formatError(err: ErrorObject): string {
  const path = err.instancePath || '(root)';
  return `${path} ${err.message ?? 'invalid'}`;
}

export function validateManifest(json: unknown): ValidationResult {
  const validate = getValidator();
  if (validate(json)) {
    return { ok: true, manifest: json as ModuleManifest };
  }
  const errors = (validate.errors ?? []).map(formatError);
  return { ok: false, errors: errors.length ? errors : ['unknown validation error'] };
}
