import { describe, expect, it } from "vitest";
import { execSchema, execSchemaFor } from "./bash-tools.schemas.js";

describe("execSchemaFor", () => {
  it("advertises host and node while the target is chosen per call", () => {
    for (const host of [undefined, null, "auto"]) {
      expect(execSchemaFor(host)).toBe(execSchema);
      expect(Object.keys(execSchemaFor(host).properties)).toEqual(
        expect.arrayContaining(["host", "node"]),
      );
    }
  });

  it("hides host and node once tools.exec.host pins the target", () => {
    const pinned = execSchemaFor("gateway");
    const keys = Object.keys(pinned.properties);
    expect(keys).not.toContain("host");
    expect(keys).not.toContain("node");
    expect(keys).toEqual(expect.arrayContaining(["command", "workdir", "timeout"]));
    expect(pinned.required).toEqual(["command"]);
  });
});
