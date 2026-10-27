import type { ApiErrorBody, FieldError } from "@goldloan/shared";

/** A failure with a known HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: FieldError[] = [],
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        fields: this.fields,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const validationError = (fields: FieldError[], message = "Some fields need attention") =>
  new AppError(400, "VALIDATION_ERROR", message, fields);

export const notFound = (code: string, message: string, fields: FieldError[] = []) =>
  new AppError(404, code, message, fields);

export function errorBody(code: string, message: string, fields: FieldError[] = []): ApiErrorBody {
  return { error: { code, message, fields } };
}
