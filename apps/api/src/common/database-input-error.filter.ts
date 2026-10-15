import { ArgumentsHost, BadRequestException, Catch, HttpException } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";

/**
 * Postgres errors that mean "the caller sent a value the database cannot read", never "the server broke":
 *   22P02 invalid_text_representation (a malformed uuid, number or enum in a URL or body),
 *   22007 invalid_datetime_format, 22008 datetime_field_overflow, 22003 numeric_value_out_of_range,
 *   22001 string_data_right_truncation.
 * LIVE-01: before this, GET /offers/undefined/rescind (or any :id route with a malformed id) answered 500.
 */
const CLIENT_INPUT_PG_CODES = new Set(["22P02", "22007", "22008", "22003", "22001"]);

export function isClientInputDatabaseError(error: unknown): boolean {
  if (error instanceof HttpException) return false;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && CLIENT_INPUT_PG_CODES.has(code);
}

/**
 * Turns those errors into a 400 with a fixed message (the database detail is never echoed back) and leaves every
 * other error to Nest's default handling, so real faults still answer 500 and are logged as before.
 */
@Catch()
export class DatabaseInputErrorFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (isClientInputDatabaseError(exception)) {
      super.catch(new BadRequestException("A value in the request is not valid (for example a malformed id)."), host);
      return;
    }
    super.catch(exception, host);
  }
}
