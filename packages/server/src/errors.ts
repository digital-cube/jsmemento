import { ERROR_CODES, type ErrorCode } from "@memento/core";

/** An error that maps to a structured `{ ok: false, error }` response. */
export class MementoError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "MementoError";
    this.code = code;
    this.status = ERROR_CODES[code];
    this.details = details;
  }
}
