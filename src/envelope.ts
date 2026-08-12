import type { CliError } from "./errors.ts";

/**
 * Every domain outcome, success or failure, is one JSON envelope on stdout —
 * an agent always parses the last stdout as JSON, never empty stdout plus
 * stderr prose. Usage faults are the exception: they exit 2 before a command
 * runs and are not envelopes.
 */
export interface Envelope<T> {
  schema_version: number;
  ok: boolean;
  error: { code: string; message: string; recovery?: string } | null;
  data: T | null;
}

export function success<T>(schemaVersion: number, data: T): Envelope<T> {
  return { schema_version: schemaVersion, ok: true, error: null, data };
}

export function failure(schemaVersion: number, error: CliError): Envelope<never> {
  const body: NonNullable<Envelope<never>["error"]> = {
    code: error.code,
    message: error.message,
  };
  if (error.recovery !== undefined) body.recovery = error.recovery;
  return { schema_version: schemaVersion, ok: false, error: body, data: null };
}
