import { demoFixtureModules, demoFixturesEnabled } from "./demo-fixtures.gate";
import { DummyModule } from "./dummy.module";

describe("demo fixtures gate (SEC-05)", () => {
  it("is off in production by default", () => {
    expect(demoFixturesEnabled({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(false);
    expect(demoFixtureModules({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toEqual([]);
  });
  it("is on in development and test", () => {
    expect(demoFixtureModules({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toEqual([DummyModule]);
    expect(demoFixturesEnabled({} as NodeJS.ProcessEnv)).toBe(true);
  });
  it("can be explicitly enabled in production (staging/demo only)", () => {
    expect(demoFixturesEnabled({ NODE_ENV: "production", ENABLE_DEMO_FIXTURES: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(demoFixturesEnabled({ NODE_ENV: "production", ENABLE_DEMO_FIXTURES: "1" } as NodeJS.ProcessEnv)).toBe(false);
  });
});
