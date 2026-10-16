import { memoizeForRequest, runWithContext } from "./request-context";
import { RequestContextMiddleware } from "./request-context";

/** The per-request memo of authorization lookups: one lookup per request per key, never shared between requests, absent outside a request. */
describe("memoizeForRequest", () => {
  const inRequest = <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      new RequestContextMiddleware().use({ header: () => undefined, ip: "127.0.0.1" } as never, { setHeader: () => undefined } as never, () => fn().then(resolve, reject));
    });

  it("asks once per request, even for simultaneous callers", async () => {
    const lookup = jest.fn(async () => true);
    await inRequest(async () => {
      const answers = await Promise.all([memoizeForRequest("k", lookup), memoizeForRequest("k", lookup), memoizeForRequest("k", lookup)]);
      expect(answers).toEqual([true, true, true]);
      await memoizeForRequest("k", lookup);
    });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("different keys are different lookups", async () => {
    const lookup = jest.fn(async () => false);
    await inRequest(async () => {
      await memoizeForRequest("a", lookup);
      await memoizeForRequest("b", lookup);
    });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("the next request asks again (an authorization change is seen on the next request)", async () => {
    let allowed = true;
    const lookup = async () => allowed;
    expect(await inRequest(() => memoizeForRequest("k", lookup))).toBe(true);
    allowed = false;
    expect(await inRequest(() => memoizeForRequest("k", lookup))).toBe(false);
  });

  it("outside a request (jobs, scripts, direct service calls) every call asks", async () => {
    const lookup = jest.fn(async () => true);
    await memoizeForRequest("k", lookup);
    await memoizeForRequest("k", lookup);
    await runWithContext({ sourceChannel: "job" }, async () => {
      await memoizeForRequest("k", lookup);
      await memoizeForRequest("k", lookup);
    });
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it("a failed lookup is not remembered", async () => {
    let calls = 0;
    const lookup = async () => {
      calls += 1;
      if (calls === 1) throw new Error("db hiccup");
      return true;
    };
    await inRequest(async () => {
      await expect(memoizeForRequest("k", lookup)).rejects.toThrow("db hiccup");
      await expect(memoizeForRequest("k", lookup)).resolves.toBe(true);
    });
  });
});
