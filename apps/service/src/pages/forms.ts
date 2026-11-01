import { ApiError, errorField, errorText } from "../lib/api.js";

/** One message per field; `form` is the error that belongs to no field. */
export type FieldErrors = Partial<Record<string, string>> & { form?: string };

/** The shortest password the server takes (`PASSWORD_MIN`). */
export const PASSWORD_MIN = 10;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type T = (section: string, term: string, params?: Record<string, string | number>) => string;

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  terms: boolean;
}

/** What the register form says before anything is sent; `{}` when it may be sent. */
export function validateRegister(input: RegisterInput, t: T): FieldErrors {
  const errors: FieldErrors = {};
  if (!input.email.trim()) errors.email = t("AUTH", "REQUIRED");
  else if (!EMAIL_RE.test(input.email.trim())) errors.email = t("AUTH", "BAD_EMAIL");
  if (input.password.length < PASSWORD_MIN) errors.password = t("AUTH", "SHORT_PASSWORD");
  if (!input.name.trim()) errors.name = t("AUTH", "REQUIRED");
  if (!input.terms) errors.terms = t("AUTH", "TERMS_REQUIRED");
  return errors;
}

/** A new password typed twice. */
export function validateNewPassword(password: string, again: string, t: T): FieldErrors {
  if (password.length < PASSWORD_MIN) return { password: t("AUTH", "SHORT_PASSWORD") };
  if (password !== again) return { again: t("AUTH", "MISMATCH") };
  return {};
}

/**
 * The server's answer as field errors: a `validation_error` under the field it names, a rate
 * limit in the site's language, the rest above the form.
 */
export function serverErrors(error: unknown, t: T): FieldErrors {
  if (!(error instanceof ApiError)) return { form: String(error) };
  if (error.code === "rate_limited") return { form: t("AUTH", "RATE_LIMITED") };
  if (error.code === "validation_error") {
    const field = errorField(error);
    if (field) return { [field]: errorText(error) };
  }
  return { form: errorText(error) };
}

export const hasErrors = (errors: FieldErrors): boolean => Object.keys(errors).length > 0;
