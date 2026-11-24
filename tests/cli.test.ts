import { readFileSync, writeFileSync } from "node:fs";
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
const EXAMPLES = ["press_feeder.tejun", "conveyor_sorter.tejun", "pick_place.tejun", "press_station.tejun"];

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

describe("tejun run", () => {
  /** Example program plus its scenario, as files in memory. */
  const withScenario = (name: string) => {
    const base = name.replace(".tejun", "");
    return memoryIo({
      [`examples/${name}`]: example(name),
      [`examples/${base}.scenario`]: example(`${base}.scenario`),
    });
  };

  /** Compare with a golden timeline, or write it when UPDATE_GOLDEN=1. */
  const expectGolden = (actual: string, file: string) => {
    const url = new URL(`./golden/${file}`, import.meta.url);
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(url, actual, "utf8");
    expect(actual).toBe(readFileSync(url, "utf8").replace(/\r\n/g, "\n"));
  };

  it.each(EXAMPLES)("prints the timeline for examples/%s with its scenario", (name) => {
    const result = runCli(["run", `examples/${name}`], withScenario(name));
    expect(result.code).toBe(0);
    expectGolden(result.stdout, name.replace(".tejun", ".timeline.txt"));
  });

  it("shows a jammed sensor causing a timeout fault and all outputs going OFF", () => {
    const result = runCli(["run", "examples/press_feeder.tejun", "--jam", "clamp_ext_ls"], withScenario("press_feeder.tejun"));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("FAULT 3 CLAMP_TIMEOUT: clamp_ext_ls not ON within 2000 ms");
    expect(result.stdout).toContain("Clamp -> Stopped                   outputs: all OFF");
    expectGolden(result.stdout, "press_feeder.jam_clamp_ext_ls.timeline.txt");
  });

  it("shows a motor whose feedback never comes on raising its start timeout", () => {
    const result = runCli(["run", "examples/press_station.tejun", "--jam", "belt_fb"], withScenario("press_station.tejun"));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("FAULT 4 BELT_NO_START: belt_fb not ON within 1000 ms");
    expect(result.stdout).toContain("Feed -> Stopped                    outputs: all OFF");
    expectGolden(result.stdout, "press_station.jam_belt_fb.timeline.txt");
  });

  it("runs without a scenario when none exists next to the program", () => {
    const io = memoryIo({ "p.tejun": example("press_feeder.tejun") });
    const result = runCli(["run", "p.tejun", "--until", "1s"], io);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("scenario none");
    expect(result.stdout).toContain("end at 1.000 s: Idle (time limit)");
  });

  it("reports an E-stop as the reason for stopping", () => {
    const io = memoryIo({ "p.tejun": example("press_feeder.tejun"), "s.scenario": "at 1 s estop_ok = off" });
    const result = runCli(["run", "p.tejun", "--scenario", "s.scenario"], io);
    expect(result.stdout).toContain("1.000  Idle -> Stopped (E-stop: not estop_ok) outputs: all OFF");
  });

  it("prints scenario errors and exits 1", () => {
    const io = memoryIo({ "p.tejun": example("press_feeder.tejun"), "p.scenario": "at 1 s part_presnt = on" });
    const result = runCli(["run", "p.tejun"], io);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("error: p.scenario:1: unknown input `part_presnt`");
  });

  it("prints program errors and exits 1", () => {
    const io = memoryIo({ "p.tejun": "station" });
    expect(runCli(["run", "p.tejun"], io).code).toBe(1);
  });

  it("exits 2 for bad options", () => {
    const io = withScenario("press_feeder.tejun");
    const path = "examples/press_feeder.tejun";
    expect(runCli(["run"], io).code).toBe(2);
    expect(runCli(["run", path, "--scenario", "missing.scenario"], io).stderr).toContain("cannot read 'missing.scenario'");
    expect(runCli(["run", path, "--jam", "clamp_ext_l"], io).stderr).toContain("did you mean 'clamp_ext_ls'?");
    expect(runCli(["run", path, "--jam", "conveyor"], io).stderr).toContain("not a bool input");
    expect(runCli(["run", path, "--jam", "clamp_ext_ls=maybe"], io).stderr).toContain("must be on or off");
    expect(runCli(["run", path, "--until", "10"], io).stderr).toContain("needs a time such as 5s");
    expect(runCli(["run", path, "--scan"], io).stderr).toContain("'--scan' needs a value");
  });
});
