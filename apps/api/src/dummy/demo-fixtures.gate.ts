import { DynamicModule, Type } from "@nestjs/common";
import { DummyModule } from "./dummy.module";

/**
 * Gap Register SEC-05. The "dummy" module is Phase 4/5 scaffolding
 * (dummy_records + /dummy and /dummy-fixtures routes) used by the RBAC,
 * workflow, entitlement and import/export test suites. It must not be
 * reachable in production. It is mounted only when NODE_ENV is not
 * "production", or when ENABLE_DEMO_FIXTURES=true is set explicitly (a
 * staging/demo tenant). The table itself stays so those suites keep working;
 * see the Step 2 report for the full-removal plan.
 */
export function demoFixturesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" || env.ENABLE_DEMO_FIXTURES === "true";
}

export function demoFixtureModules(env: NodeJS.ProcessEnv = process.env): Array<Type<unknown> | DynamicModule> {
  return demoFixturesEnabled(env) ? [DummyModule] : [];
}
