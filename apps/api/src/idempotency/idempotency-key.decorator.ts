import { BadRequestException, createParamDecorator, ExecutionContext } from "@nestjs/common";

/**
 * Reads the `Idempotency-Key` request header. `@IdempotencyKey()` returns it
 * (or undefined); `@IdempotencyKey({ required: true })` rejects the request
 * with 400 when it is missing — use that on money-moving endpoints.
 */
export const IdempotencyKey = createParamDecorator((opts: { required?: boolean } | undefined, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest();
  const raw = req.headers["idempotency-key"];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key && opts?.required) {
    throw new BadRequestException("An Idempotency-Key header is required for this operation.");
  }
  return key as string | undefined;
});
