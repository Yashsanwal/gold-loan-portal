import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import type { z } from "zod";
import { toFieldErrors } from "@goldloan/shared";
import { AppError, errorBody, validationError } from "./errors.js";
import type { Logger } from "./logger.js";

/** Validates `value` against a Zod schema or throws a 400 in the standard error shape. */
export function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown, source = "body"): z.output<S> {
  if (source === "body" && (value === null || typeof value !== "object" || Array.isArray(value))) {
    throw validationError(
      [{ field: "body", message: "Send a JSON object with Content-Type: application/json" }],
      "Request body must be a JSON object",
    );
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = toFieldErrors(result.error).map((field) =>
      field.field === "body" ? { ...field, field: source } : field,
    );
    throw validationError(fields);
  }
  return result.data;
}

/** Full path without the query string (req.path is relative to the router mount point). */
function pathOf(req: Request): string {
  return req.originalUrl.split("?")[0] ?? req.originalUrl;
}

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get("x-request-id");
  const id = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  res.locals.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
};

export function accessLog(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      logger.info("request", {
        requestId: res.locals.requestId,
        method: req.method,
        path: pathOf(req),
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
      });
    });
    next();
  };
}

export const notFoundRoute: RequestHandler = (req, res) => {
  res.status(404).json(errorBody("ROUTE_NOT_FOUND", `No route for ${req.method} ${pathOf(req)}`));
};

interface BodyParserError {
  type?: string;
  status?: number;
}

/**
 * Last middleware. Every failure leaves as JSON in the `{ error: { code, message, fields } }`
 * shape. Unknown errors become a generic 500, logged with the request id and never sent to the client.
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof AppError) {
      res.status(err.status).json(err.toBody());
      return;
    }

    const parserError = err as BodyParserError;
    if (parserError?.type === "entity.parse.failed") {
      res
        .status(400)
        .json(errorBody("INVALID_JSON", "Request body is not valid JSON", [{ field: "body", message: "Malformed JSON" }]));
      return;
    }
    if (parserError?.type === "entity.too.large") {
      res.status(413).json(errorBody("PAYLOAD_TOO_LARGE", "Request body is too large"));
      return;
    }
    if (parserError?.type === "encoding.unsupported" || parserError?.type === "charset.unsupported") {
      res.status(415).json(errorBody("UNSUPPORTED_ENCODING", "Use UTF-8 encoded JSON"));
      return;
    }

    logger.error("unhandled error", {
      requestId: res.locals.requestId,
      method: req.method,
      path: pathOf(req),
      error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
    });
    res
      .status(500)
      .json(
        errorBody(
          "INTERNAL_ERROR",
          `Something went wrong on our side. Please try again. (ref ${String(res.locals.requestId)})`,
        ),
      );
  };
}
