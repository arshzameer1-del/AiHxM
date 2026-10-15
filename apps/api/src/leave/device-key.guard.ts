import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { AttendanceDevicesService } from "./attendance-devices.service";

export type DeviceAuthedRequest = Request & { deviceCompanyId: string };

/**
 * Authenticates a punch-ingestion request from a device (TLM-05): no user session, only the
 * per-device key sent as `x-device-key` for the device id in the URL. The key is matched
 * through its stored SHA-256 hash; an inactive device or a wrong key is a plain 401.
 */
@Injectable()
export class DeviceKeyGuard implements CanActivate {
  constructor(private readonly devices: AttendanceDevicesService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<DeviceAuthedRequest>();
    const key = req.headers["x-device-key"];
    const found = typeof key === "string" ? await this.devices.authenticate(req.params.deviceId, key.trim()) : null;
    if (!found) throw new UnauthorizedException("Invalid device credentials");
    req.deviceCompanyId = found.companyId;
    return true;
  }
}
