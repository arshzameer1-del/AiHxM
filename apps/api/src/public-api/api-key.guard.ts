import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { ApiKeysService } from "./api-keys.service";

/** Bearer-key guard for /public-api. A missing, malformed, unknown or revoked key all look the same: 401. */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly keys: ApiKeysService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header = String(req.headers["authorization"] ?? "");
    const m = /^Bearer (\S+)$/.exec(header);
    const key = m ? await this.keys.authenticate(m[1]) : null;
    if (!key) throw new UnauthorizedException("Missing or invalid API key");
    req.apiKey = key;
    return true;
  }
}
