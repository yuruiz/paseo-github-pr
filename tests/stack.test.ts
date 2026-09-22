import { expect, test } from "vitest";
import { inferChain, nextInChain } from "../server/stack";
import { pr } from "./fixtures";
const bottom = pr({ id: "p1", number: 1, headRepo: "org/repo", headRef: "one" });
const middle = pr({ id: "p2", number: 2, headRepo: "org/repo", headRef: "two", baseRef: "one" });
const top = pr({ id: "p3", number: 3, headRepo: "org/repo", headRef: "three", baseRef: "two" });
test("any layer resolves the same trunk-first chain", () => {
  for (const p of [bottom, middle, top])
    expect(inferChain([top, bottom, middle], p.id)).toEqual(["p1", "p2", "p3"]);
});
test("merge progression skips merged layers but never closed unmerged layers", () => {
  expect(nextInChain([bottom, middle, top])?.id).toBe("p1");
  expect(nextInChain([{ ...bottom, state: "merged" }, middle, top])?.id).toBe("p2");
  expect(
    nextInChain([{ ...bottom, state: "merged" }, { ...middle, state: "merged" }, top])?.id,
  ).toBe("p3");
  expect(
    nextInChain([bottom, middle, top].map((p) => ({ ...p, state: "merged" }))),
  ).toBeUndefined();
  expect(() => nextInChain([{ ...bottom, state: "closed" }, middle, top])).toThrow(
    "without merging",
  );
});
test("forks, cycles, missing parents, and cross-fork lookalikes do not become a stack", () => {
  expect(() => inferChain([bottom, middle, { ...top, baseRef: "one" }], "p1")).toThrow("Forked");
  expect(() => inferChain([{ ...bottom, baseRef: "two" }, middle], "p1")).toThrow("Cyclic");
  expect(() => inferChain([middle], "p2")).toThrow("Unknown stack parent");
  expect(() => inferChain([{ ...bottom, headRepo: "fork/repo" }, middle], "p2")).toThrow(
    "Unknown stack parent",
  );
});
