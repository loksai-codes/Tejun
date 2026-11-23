import { describe, expect, it } from "vitest";
import { VERSION as compilerVersion } from "@tejun/compiler";
import { VERSION as runtimeVersion } from "@tejun/runtime";
import { runCli } from "@tejun/cli";

describe("workspace wiring", () => {
  it("compiler and runtime packages load", () => {
    expect(compilerVersion).toBe("0.0.0");
    expect(runtimeVersion).toBe("0.0.0");
  });

  it("cli prints usage with no arguments", () => {
    const result = runCli([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage:");
  });

  it("cli rejects unknown commands in English and Japanese", () => {
    const result = runCli(["frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown command 'frobnicate'");
    expect(result.stderr).toContain("不明なコマンド");
  });
});
