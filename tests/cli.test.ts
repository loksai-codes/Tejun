import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "@tejun/cli";

/** In-memory files. A missing path fails like the real file system; writes are recorded. */
function memoryIo(files: Record<string, string>): CliIo & { written: Map<string, string>; dirs: string[] } {
  const written = new Map<string, string>();
  const dirs: string[] = [];
  return {
    written,
    dirs,
    readFile(path) {
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
    makeDir: (path) => void dirs.push(path),
    writeFile: (path, text) => void written.set(path.replace(/\\/g, "/"), text),
  };
}

const example = (name: string) => readFileSync(new URL(`../examples/${name}`, import.meta.url), "utf8");
const golden = (name: string) => readFileSync(new URL(`./golden/${name}`, import.meta.url), "utf8");
const EXAMPLES = ["press_feeder.tejun", "conveyor_sorter.tejun", "pick_place.tejun"];

describe("tejun check", () => {
  it.each(EXAMPLES)("prints OK for examples/%s", (name) => {
    const path = `examples/${name}`;
    const result = runCli(["check", path], memoryIo({ [path]: example(name) }));
    expect(result).toEqual({ code: 0, stdout: "OK\n", stderr: "" });
  });

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

  it("reports read errors and internal errors without a stack trace", () => {
    const io = memoryIo({});
    io.readFile = () => {
      throw new TypeError("boom");
    };
    expect(runCli(["check", "x"], io).stderr).toContain("it could not be read");

    io.readFile = () => null as unknown as string;
    const crash = runCli(["check", "x"], io);
    expect(crash.code).toBe(2);
    expect(crash.stderr).toContain("internal error");
    expect(crash.stderr).not.toMatch(/\n\s+at /);
  });
});

describe("tejun build", () => {
  it.each(EXAMPLES)("writes out/<name>.st for examples/%s", (name) => {
    const path = `examples/${name}`;
    const io = memoryIo({ [path]: example(name) });
    const stName = name.replace(".tejun", ".st");
    const result = runCli(["build", path], io);
    expect(result).toEqual({ code: 0, stdout: `wrote out/${stName}\n`, stderr: "" });
    expect(io.dirs).toEqual(["out"]);
    expect(io.written.get(`out/${stName}`)).toBe(golden(stName));
  });

  it("honours -o", () => {
    const io = memoryIo({ "p.tejun": example("press_feeder.tejun") });
    const result = runCli(["build", "p.tejun", "-o", "plc/gen"], io);
    expect(result.stdout).toBe("wrote plc/gen/p.st\n");
    expect([...io.written.keys()]).toEqual(["plc/gen/p.st"]);
  });

  it("writes nothing and exits 1 when the program has errors", () => {
    const text = example("press_feeder.tejun").replace(/^\s*state Home.*\n/m, "");
    const io = memoryIo({ "p.tejun": text });
    const result = runCli(["build", "p.tejun"], io);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("error[T0203]");
    expect(io.written.size).toBe(0);
  });

  it("exits 2 for bad arguments or an unwritable directory", () => {
    const files = { "p.tejun": example("press_feeder.tejun") };
    expect(runCli(["build"], memoryIo(files)).code).toBe(2);
    expect(runCli(["build", "p.tejun", "-o"], memoryIo(files)).stderr).toContain("'-o' needs a directory");
    expect(runCli(["build", "p.tejun", "--fast"], memoryIo(files)).stderr).toContain("unexpected argument '--fast'");

    const io = memoryIo(files);
    io.writeFile = () => {
      throw new Error("EACCES");
    };
    const result = runCli(["build", "p.tejun"], io);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("cannot write 'out/p.st'");
  });
});
