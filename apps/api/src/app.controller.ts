import { Controller, Get, HttpException, HttpStatus } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { AppService } from "./app.service";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get("health")
  @SkipThrottle()
  getHealth() {
    return this.appService.getHealth();
  }

  /** Use this for the platform health check and uptime monitors: 503 when the database cannot be reached. */
  @Get("health/ready")
  @SkipThrottle()
  async getReady() {
    const { ready, body } = await this.appService.getReadiness();
    if (!ready) throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }
}
