import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("../examples/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".tejun"));

describe("examples", () => {
  it("includes the three Phase 1 programs and the Motor + Cylinder station", () => {
    expect(files.sort()).toEqual([
      "conveyor_sorter.tejun",
      "pick_place.tejun",
      "press_feeder.tejun",
      "press_station.tejun",
    ]);
  });

  // The Phase 1 programs are kept short; press_station is a realistic station.
  const maxLines: Record<string, number> = { "press_station.tejun": 100 };

  it.each(files)("%s stays short", (file) => {
    const text = readFileSync(new URL(file, dir), "utf8");
    const lines = text.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(maxLines[file] ?? 40);
  });
});
