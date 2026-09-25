import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import type { Response } from "express";

const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

/**
 * Converts any thrown HttpException into RFC 7644 §3.12's error shape
 * (`{"schemas":[...],"status":"<code>","detail":"..."}`) instead of Nest's
 * own default `{statusCode, message, error}` body. A real IdP's SCIM
 * connector code parses `detail` and the numeric `status` specifically —
 * Nest's default body would still carry the correct HTTP status code, but
 * would show as a confusing "unexpected response format" in an IdP's own
 * SCIM setup/test screen instead of the actual, readable failure reason
 * (e.g. "A userName or email attribute is required...").
 */
@Catch(HttpException)
export class ScimExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const status = exception.getStatus();
    const body = exception.getResponse();

    let detail: string = exception.message;
    if (typeof body === "string") {
      detail = body;
    } else if (body && typeof body === "object") {
      const message = (body as { message?: unknown }).message;
      if (typeof message === "string") detail = message;
      else if (Array.isArray(message)) detail = message.join("; ");
    }

    res.status(status).json({
      schemas: [SCIM_ERROR_SCHEMA],
      status: String(status),
      detail,
    });
  }
}
