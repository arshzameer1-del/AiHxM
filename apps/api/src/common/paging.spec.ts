import { MAX_PAGE_SIZE, pageOf } from "./paging";

const fakeRes = () => {
  const headers: Record<string, string> = {};
  return { headers, res: { setHeader: (k: string, v: string) => (headers[k] = v) } as never };
};

describe("pageOf", () => {
  const items = Array.from({ length: 12 }, (_, i) => i);

  it("returns everything (up to the ceiling) when no paging is asked for, and reports the total", () => {
    const { res, headers } = fakeRes();
    expect(pageOf(items, undefined, undefined, res)).toHaveLength(12);
    expect(headers["X-Total-Count"]).toBe("12");
  });

  it("applies limit and offset", () => {
    const { res } = fakeRes();
    expect(pageOf(items, "5", "10", res)).toEqual([10, 11]);
    expect(pageOf(items, "5", "0", res)).toEqual([0, 1, 2, 3, 4]);
  });

  it("ignores nonsense values and never exceeds the ceiling", () => {
    const { res } = fakeRes();
    expect(pageOf(items, "abc", "-4", res)).toHaveLength(12);
    const big = Array.from({ length: MAX_PAGE_SIZE + 10 }, (_, i) => i);
    expect(pageOf(big, "999999", undefined, res)).toHaveLength(MAX_PAGE_SIZE);
  });
});
