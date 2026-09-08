import { describe, expect, it } from "vitest";
import { KERNEL_VERSION } from "./index.js";

describe("scaffold", () => {
  it("exports a version marker", () => {
    expect(KERNEL_VERSION).toBeTypeOf("string");
  });
});
