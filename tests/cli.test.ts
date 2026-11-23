import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "@tejun/cli";

/** In-memory files; a missing path fails like the real file system. */
function memoryIo(files: Record<string, string>): CliIo {
  return {
    readFile(path) {
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
  };
}

const example = (name: string) => readFileSync(new URL(`../examples/${name}`, import.meta.url), "utf8");

describe("tejun check", () => {
  it.each(["press_feeder.tejun", "conveyor_sorter.tejun", "pick_place.tejun"])(
    "prints OK for examples/%s",
    (name) => {
      const path = `examples/${name}`;
      const result = runCli(["check", path], memoryIo({ [path]: example(name) }));
      expect(result).toEqual({ code: 0, stdout: "OK\n", stderr: "" });
    },
  );

  it("prints diagnostics and exits 1 for a broken file", () => {
    const fixture = "tests/fixtures/errors/T0010_missing_colon.tejun";
    const text = readFileSync(new URL(`../${fixture}`, import.meta.url), "utf8");
    const expected = readFileSync(new URL(`../${fixture.replace(".tejun", ".expected")}`, import.meta.url), "utf8");
    const result = runCli(["check", fixture], memoryIo({ [fixture]: text }));
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(expected);
  });

  it("shows Windows paths with forward slashes", () => {
    const result = runCli(["check", "dir\\bad.tejun"], memoryIo({ "dir\\bad.tejun": "station" }));
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("--> dir/bad.tejun:1:8");
  });

  it("exits 2 for a missing file", () => {
    const result = runCli(["check", "nope.tejun"], memoryIo({}));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("cannot read 'nope.tejun': no such file");
    expect(result.stderr).toContain("ファイルが存在しません");
  });

  it("exits 2 without a file argument or with extra arguments", () => {
    expect(runCli(["check"], memoryIo({})).code).toBe(2);
    expect(runCli(["check", "a", "b"], memoryIo({ a: "" })).stderr).toContain("unexpected argument 'b'");
  });

  it("reports an internal error without a stack trace", () => {
    const io: CliIo = {
      readFile: () => {
        throw new TypeError("boom");
      },
    };
    // A non-ENOENT read error is a normal "cannot read" message...
    expect(runCli(["check", "x"], io).stderr).toContain("it could not be read");
    // ...and an unexpected crash elsewhere is an internal error.
    const crash = runCli(["check", "x"], { readFile: () => null as unknown as string });
    expect(crash.code).toBe(2);
    expect(crash.stderr).toContain("internal error");
    expect(crash.stderr).not.toMatch(/\n\s+at /);
  });
});
