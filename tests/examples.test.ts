import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("../examples/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".tejun"));

describe("examples", () => {
  it("includes the three Phase 1 programs", () => {
    expect(files.sort()).toEqual([
      "conveyor_sorter.tejun",
      "pick_place.tejun",
      "press_feeder.tejun",
    ]);
  });

  it.each(files)("%s stays under 40 lines", (file) => {
    const text = readFileSync(new URL(file, dir), "utf8");
    const lines = text.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(40);
  });
});
