/**
 * Debugger probes in the generated C++: the per-POU dual path (an unprobed
 * clone with call-free polls and a probed clone entered by on-stack transfer),
 * the probe-off build, and the shared-global lock rule.
 *
 * Each block names the acceptance criterion it evidences:
 *   - shape        : the unprobed clone is the probe-off output plus polls, and
 *                    every planned probe is emitted once, in a probed clone.
 *   - A027         : every poll's idle path is one load, at most one compare and
 *                    one branch, read from the object code (local toolchain).
 *   - A028 / A019  : probe-off has no probe code, links without the debug ABI,
 *                    and still serves watch and force through the debug table.
 *   - transfer     : arming mid-loop continues in the probed clone with the same
 *                    locals; broken transfers (no polls, restart at entry, leaf
 *                    called unprobed) are shown red.
 *   - A204         : no probe parks under a shared-global lock (S1-S8):
 *                    build-inspect plus a two-thread run against the stub host.
 *
 * The host side is `src/runtime/test/debug_probe_stub.hpp`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import type { CompileOptions } from "../../src/types.js";
import { loadStlibFromFile } from "../../src/node/library-loader.js";
import {
  hasGpp,
  cxxEnv,
  RUNTIME_INCLUDE_PATH,
  TEST_RUNTIME_PATH,
  runE2ETestPipeline,
} from "./test-helpers.js";

type Result = ReturnType<typeof compile>;

const IEC_STDLIB = loadStlibFromFile(
  path.resolve(__dirname, "../../libs/iec-standard-fb.stlib"),
);
const VALIDATION_DIR = path.resolve(__dirname, "../st-validation");

/** openplc-runtime's Makefile.strucpp flags, minus the GCC-only one on clang. */
const isRealGcc = hasGpp && /Free Software Foundation/.test(
  execFileSync("g++", ["--version"], { encoding: "utf8" }),
);
const RUNTIME_FLAGS = [
  "-std=c++17", "-O1", "-pipe", "-fPIC", "-Wall", "-DSTRUCPP_THREADED",
  ...(isRealGcc ? ["-fno-gnu-unique"] : []),
];

function build(source: string, opts: Partial<CompileOptions> = {}): Result {
  const r = compile(source, {
    headerFileName: "generated.hpp",
    libraries: [IEC_STDLIB],
    ...opts,
  });
  expect(r.errors.map((e) => e.message)).toEqual([]);
  expect(r.success).toBe(true);
  return r;
}

/** Probe ID of the kind-0 probe on the line carrying `(*@marker*)`. */
function probeAt(source: string, r: Result, marker: string): number {
  const line = source.split("\n").findIndex((l) => l.includes(`(*@${marker}*)`)) + 1;
  expect(line).toBeGreaterThan(0);
  const p = r.debugInfo!.probes;
  const id = p.line.findIndex((l, i) => l === line && p.kind[i] === 0);
  expect(id, `probe for @${marker}`).toBeGreaterThanOrEqual(0);
  return id;
}

let tmpRoot: string;
beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-probes-"));
});
afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeTree(name: string, r: Result, patch?: (code: string) => string): {
  dir: string;
  cpps: string[];
} {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "generated.hpp"), r.headerCode);
  const cpps = r.cppFiles.map((f) => {
    const p = path.join(dir, f.name);
    fs.writeFileSync(p, patch ? patch(f.content) : f.content);
    return p;
  });
  return { dir, cpps };
}

function gxx(args: string[]): { ok: boolean; out: string } {
  const res = spawnSync("g++", args, { encoding: "utf8", env: cxxEnv ?? process.env });
  return { ok: res.status === 0, out: `${res.stdout}${res.stderr}` };
}

/** Link `main` against the generated TUs and run it. */
function buildAndRun(
  name: string,
  r: Result,
  main: string,
  opts: {
    flags?: string[];
    include?: string;
    patch?: (code: string) => string;
    args?: string[];
    extraCpp?: Record<string, string>;
  } = {},
): { status: number | null; out: string } {
  const { dir, cpps } = writeTree(name, r, opts.patch);
  const mainPath = path.join(dir, "main.cpp");
  fs.writeFileSync(mainPath, main);
  const extra = Object.entries(opts.extraCpp ?? {}).map(([f, c]) => {
    const p = path.join(dir, f);
    fs.writeFileSync(p, c);
    return p;
  });
  const bin = path.join(dir, "a.out");
  const c = gxx([
    ...(opts.flags ?? RUNTIME_FLAGS), "-pthread",
    `-I${opts.include ?? RUNTIME_INCLUDE_PATH}`, `-I${TEST_RUNTIME_PATH}`, `-I${dir}`,
    mainPath, ...cpps, ...extra, "-o", bin,
  ]);
  expect(c.out, "g++").toBe(c.ok ? c.out : "<compiled>");
  const res = spawnSync(bin, opts.args ?? [], { encoding: "utf8", timeout: 20000 });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

/** A copy of the runtime headers with one textual change, for red builds. */
function patchedRuntime(name: string, file: string, from: string, to: string): string {
  const dir = path.join(tmpRoot, `rt-${name}`);
  fs.cpSync(RUNTIME_INCLUDE_PATH, dir, { recursive: true });
  const p = path.join(dir, file);
  const text = fs.readFileSync(p, "utf8");
  expect(text.includes(from), `${file} still contains the text the red build removes`).toBe(true);
  fs.writeFileSync(p, text.split(from).join(to));
  return dir;
}

// ---------------------------------------------------------------------------
// Corpus for the shape checks: every validation source, plus inline programs
// covering methods, properties, functions with locals, loops and FB calls.
// ---------------------------------------------------------------------------

const SHAPES = `
FUNCTION Clamp : DINT
  VAR_INPUT v : DINT; lo : DINT; hi : DINT; END_VAR
  IF v < lo THEN
    Clamp := lo;
  ELSIF v > hi THEN
    Clamp := hi;
  ELSE
    Clamp := v;
  END_IF;
END_FUNCTION

FUNCTION SumTo : DINT
  VAR_INPUT n : DINT; END_VAR
  VAR i : DINT; acc : DINT := 0; tmp : ARRAY[1..4] OF INT; END_VAR
  FOR i := 1 TO n DO
    acc := acc + Clamp(i, 0, 100);
    tmp[1] := 1;
  END_FOR;
  WHILE acc > 1000000 DO
    acc := acc - 1;
  END_WHILE;
  REPEAT
    acc := acc + 0;
  UNTIL TRUE
  END_REPEAT;
  SumTo := acc;
END_FUNCTION

FUNCTION_BLOCK Counter
  VAR_INPUT x : DINT; END_VAR
  VAR_OUTPUT y : DINT; END_VAR
  VAR n : DINT; END_VAR
  METHOD PUBLIC Bump : DINT
    VAR_INPUT d : DINT; END_VAR
    VAR k : DINT; END_VAR
    FOR k := 1 TO d DO
      n := n + 1;
    END_FOR;
    Bump := n;
  END_METHOD
  PROPERTY PUBLIC Level : DINT
    GET
      Level := n;
    END_GET
    SET
      n := Level;
    END_SET
  END_PROPERTY
  y := x + SumTo(3);
  n := THIS.Bump(2);
END_FUNCTION_BLOCK

PROGRAM Main
  VAR c : Counter; t : TON; k : INT; r : DINT; END_VAR
  FOR k := 1 TO 3 DO
    c(x := k);
    t(IN := TRUE, PT := T#10ms);
    CASE k OF
      1: r := c.y;
      2: r := c.Level;
    ELSE
      c.Level := 5;
    END_CASE;
  END_FOR;
  r := SumTo(r);
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK t0(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM instance0 WITH t0 : Main;
  END_RESOURCE
END_CONFIGURATION
`;

function validationSources(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".st") && !e.name.startsWith("test_")) {
        out.push([path.relative(VALIDATION_DIR, p), fs.readFileSync(p, "utf8")]);
      }
    }
  };
  walk(VALIDATION_DIR);
  return out.sort(([a], [b]) => a.localeCompare(b));
}

const BLOCK = /^[ \t]*\/\/ strucpp:(debug-probes|probed-clone) begin[\s\S]*?\/\/ strucpp:\1 end[^\n]*\n/gm;

/** Probe-on output with everything the dual path adds taken out. */
function stripProbes(code: string): string {
  return code
    .replace(BLOCK, "")
    .split("\n")
    .filter((l) => !/^\s*STRUCPP_POLL\(/.test(l))
    .filter((l) => !/__dbg_(probed|entry)\(/.test(l))
    .map((l) => l.replace(/^STRUCPP_DBG_UNPROBED /, ""))
    .join("\n");
}

function cppOf(r: Result): string {
  return r.cppFiles.map((f) => `//// ${f.name}\n${f.content}`).join("\n");
}

describe("probe-on codegen: per-POU dual path (ADR-001 D10.6, A″ form)", () => {
  const corpus: Array<[string, string]> = [["inline:shapes", SHAPES], ...validationSources()];

  it("every corpus program: the unprobed clone is the probe-off output plus polls, and each planned probe is emitted exactly once", () => {
    let compared = 0;
    for (const [name, src] of corpus) {
      const off = compile(src, { headerFileName: "generated.hpp", libraries: [IEC_STDLIB], debugProbes: false });
      if (!off.success) continue; // a library fragment with no program; probe-on must agree
      const on = compile(src, { headerFileName: "generated.hpp", libraries: [IEC_STDLIB] });
      expect(on.success, name).toBe(true);
      compared++;

      expect(stripProbes(cppOf(on)), name).toBe(stripProbes(cppOf(off)));
      expect(stripProbes(on.headerCode), name).toBe(stripProbes(off.headerCode));

      const ids = [...cppOf(on).matchAll(/STRUCPP_PROBE\((\d+)\)/g)].map((m) => Number(m[1]));
      const planned = on.debugInfo!.probes.line.length;
      expect([...ids].sort((a, b) => a - b), name).toEqual([...Array(planned).keys()]);
      // Polls exist only in unprobed clones, probes only in probed clones.
      for (const f of on.cppFiles) {
        const clones = [...f.content.matchAll(BLOCK)].map((m) => m[0]).join("\n");
        const rest = f.content.replace(BLOCK, "");
        expect(rest, `${name} ${f.name}: probe outside a probed clone`).not.toMatch(/STRUCPP_PROBE\(/);
        expect(clones, `${name} ${f.name}: poll inside a probed clone`).not.toMatch(/STRUCPP_POLL\(/);
      }
    }
    expect(compared).toBeGreaterThan(40);
  });

  it("polls sit at POU entry, loop back-edges and call returns, each with a matching re-entry label", () => {
    const r = build(SHAPES);
    const main = r.cppFiles.find((f) => f.name === "pou_MAIN.cpp")!.content;
    const unprobed = main.replace(BLOCK, "");
    const probed = [...main.matchAll(BLOCK)].map((m) => m[0]).join("\n");
    const sites = [...unprobed.matchAll(/STRUCPP_POLL\((\d+), /g)].map((m) => Number(m[1]));
    // entry, back-edge of FOR k, after c(...), after t(...), after r := SumTo(r)
    expect(sites).toEqual([0, 1, 2, 3, 4]);
    for (const k of sites.filter((s) => s > 0)) {
      expect(probed).toContain(`case ${k}: goto __osr_${k};`);
      expect(probed).toMatch(new RegExp(`__osr_${k}:;`));
    }
    // A taken poll leaves by a tail return into the probed clone.
    expect(unprobed).toMatch(/STRUCPP_POLL\(0, __dbg_probed\(0\)\);/);
    // Functions hand over their parameters and locals by value.
    const sum = r.cppFiles.find((f) => f.name === "pou_SUMTO.cpp")!.content;
    expect(sum).toMatch(/STRUCPP_POLL\(\d+, SUMTO__dbg_probed\(\d+, N, I, ACC, TMP, SUMTO_result\)\);/);
    // The probed clone links a frame; the unprobed clone has none.
    expect(probed).toContain("STRUCPP_FRAME(");
    expect(unprobed).not.toContain("STRUCPP_FRAME(");
    // Condition probes on loops and ELSIF.
    const clamp = r.cppFiles.find((f) => f.name === "pou_CLAMP.cpp")!.content;
    expect(clamp).toMatch(/else if \(\(STRUCPP_PROBE\(\d+\), /);
  });

  it("the A‴ leaf rule is off by default and, when on, drops the entry poll of leaves only", () => {
    const def = build(SHAPES);
    const leaf = build(SHAPES, { debugProbeLeafRule: true });
    const file = (r: Result, n: string): string => r.cppFiles.find((f) => f.name === n)!.content;
    // CLAMP: no call, no loop, 5 statements -> a leaf.
    expect(file(def, "pou_CLAMP.cpp")).toMatch(/STRUCPP_POLL\(0, /);
    expect(file(leaf, "pou_CLAMP.cpp")).not.toMatch(/STRUCPP_POLL\(/);
    // SUMTO loops and calls; COUNTER calls; MAIN is a program: not leaves.
    for (const n of ["pou_SUMTO.cpp", "pou_COUNTER.cpp", "pou_MAIN.cpp"]) {
      expect(file(leaf, n)).toMatch(/STRUCPP_POLL\(0, /);
    }
    // A probed caller calls the leaf's probed entry directly.
    const sumProbed = [...file(leaf, "pou_SUMTO.cpp").matchAll(BLOCK)].map((m) => m[0]).join("\n");
    expect(sumProbed).toContain("CLAMP__dbg_entry(");
    expect(file(def, "pou_SUMTO.cpp")).not.toContain("CLAMP__dbg_entry(");
  });
});

// ---------------------------------------------------------------------------
// A027: poll shape in the object code.
// ---------------------------------------------------------------------------

interface ShapeReport {
  sites: number;
  bad: string[];
  slowCalls: string[];
}

/**
 * Read every load of `strucpp_dbg_active` in the unprobed functions of an
 * object file and check the instructions that follow it: at most one compare
 * or test, then a conditional branch. Also flags any call to a slow path from
 * an unprobed function. arm64 (ELF or Mach-O) and x86-64 ELF.
 */
function pollShape(obj: string): ShapeReport {
  const dis = execFileSync("objdump", ["-d", "-r", "--no-show-raw-insn", obj], {
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  const report: ShapeReport = { sites: 0, bad: [], slowCalls: [] };
  let fn = "";
  type Insn = { text: string; relocs: string[] };
  const funcs = new Map<string, Insn[]>();
  for (const raw of dis.split("\n")) {
    const head = /^[0-9a-f]+ <(.+)>:$/.exec(raw.trim());
    if (head) {
      fn = head[1]!;
      funcs.set(fn, []);
      continue;
    }
    if (!fn) continue;
    const reloc = /^\s*[0-9a-f]+:\s+(R_\S+|ARM64_RELOC_\S+|X86_64_RELOC_\S+)\s+(\S+)/.exec(raw);
    const list = funcs.get(fn)!;
    if (reloc) {
      list[list.length - 1]?.relocs.push(reloc[2]!);
      continue;
    }
    const insn = /^\s*[0-9a-f]+:\s+(.*)$/.exec(raw);
    if (insn) list.push({ text: insn[1]!.trim(), relocs: [] });
  }
  const isBranch = (t: string): boolean =>
    /^(tbnz|tbz|cbnz|cbz|b\.(ne|eq)|jne|je|jnz|jz)\b/.test(t);
  const isCompare = (t: string): boolean => /^(tst|cmp|ands|test[bl]?|cmp[bl]?)\b/.test(t);
  for (const [name, insns] of funcs) {
    if (/__dbg_(probed|entry)/.test(name)) continue;
    insns.forEach((ins, i) => {
      if (/^(bl|call[q]?)\b/.test(ins.text) &&
          ins.relocs.concat(ins.text).some((s) => /strucpp_dbg_(hit|frame_link)|strucpp_dbg_test_poll/.test(s))) {
        report.slowCalls.push(`${name}: ${ins.text}`);
      }
      if (!ins.relocs.some((s) => /strucpp_dbg_active/.test(s))) return;
      if (/^adrp\b/.test(ins.text)) return; // page address, not a memory access
      report.sites++;
      const next = insns.slice(i + 1, i + 3).map((n) => n.text);
      const ok =
        isBranch(next[0] ?? "") ||
        (isCompare(next[0] ?? "") && isBranch(next[1] ?? "")) ||
        (/^(testb|cmpb)\b/.test(ins.text) && isBranch(next[0] ?? ""));
      if (!ok) report.bad.push(`${name}: ${ins.text} ; ${next.join(" ; ")}`);
    });
  }
  return report;
}

const shapeArch = (() => {
  if (!hasGpp) return undefined;
  const target = execFileSync("g++", ["-dumpmachine"], { encoding: "utf8" });
  return /^(aarch64|arm64|x86_64)/.test(target) ? target.trim() : undefined;
})();

describe.skipIf(!shapeArch)(`A027: poll shape in the object code (${shapeArch ?? "unsupported target"})`, () => {
  function objects(name: string, r: Result, include = RUNTIME_INCLUDE_PATH): ShapeReport {
    const { dir, cpps } = writeTree(name, r);
    const total: ShapeReport = { sites: 0, bad: [], slowCalls: [] };
    for (const cpp of cpps) {
      const obj = cpp.replace(/\.cpp$/, ".o");
      const c = gxx([...RUNTIME_FLAGS, `-I${include}`, `-I${dir}`, "-c", cpp, "-o", obj]);
      expect(c.out, `g++ -c ${path.basename(cpp)}`).toBe(c.ok ? c.out : "<compiled>");
      const s = pollShape(obj);
      total.sites += s.sites;
      total.bad.push(...s.bad);
      total.slowCalls.push(...s.slowCalls);
    }
    return total;
  }
  const planted = (r: Result): number =>
    r.cppFiles.reduce((n, f) => n + [...f.content.matchAll(/^\s*STRUCPP_POLL\(/gm)].length, 0);

  it("every planted poll is one load, at most one compare and one branch, with no slow path on the idle path", () => {
    const r = build(SHAPES);
    const s = objects("shape-on", r);
    expect(planted(r)).toBeGreaterThan(10);
    expect(s.sites).toBe(planted(r));
    expect(s.bad).toEqual([]);
    expect(s.slowCalls).toEqual([]);
  });

  it("red: a poll made an out-of-line call fails the shape check", () => {
    const r = build(SHAPES);
    const rt = patchedRuntime(
      "pollcall",
      "debug_probe.hpp",
      "#define STRUCPP_DBG_ACTIVE_NOW() (*static_cast<volatile uint8_t*>(&strucpp_dbg_active) & STRUCPP_DBG_ACTIVE)",
      'extern "C" uint8_t strucpp_dbg_test_poll(void);\n#define STRUCPP_DBG_ACTIVE_NOW() (strucpp_dbg_test_poll() + (0 & strucpp_dbg_active))',
    );
    const s = objects("shape-red", r, rt);
    expect(s.slowCalls.length + s.bad.length + Math.abs(s.sites - planted(r))).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// A028 / A019: probe-off.
// ---------------------------------------------------------------------------

const PLANT = `
PROGRAM Main
  VAR_INPUT in1 : INT; END_VAR
  VAR count : DINT; out1 : INT; END_VAR
  count := count + 1;
  out1 := in1;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK t0(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM instance0 WITH t0 : Main;
  END_RESOURCE
END_CONFIGURATION
`;

const PROBE_MARKERS = /STRUCPP_PROBE|STRUCPP_POLL|STRUCPP_FRAME|__dbg_|strucpp_dbg_(flags|hit|active|frame|lock_depth)|debug_probe\.hpp/;

describe.skipIf(!hasGpp)("A028 / A019: probe-off build", () => {
  it("A028: no probe reference in the generated C++ or the object code; probe-on has them", () => {
    for (const [src, label] of [[PLANT, "plant"], [SHAPES, "shapes"]] as const) {
      const off = build(src, { debugProbes: false });
      expect(`${off.headerCode}\n${cppOf(off)}`, label).not.toMatch(PROBE_MARKERS);
      const { dir, cpps } = writeTree(`off-${label}`, off);
      const syms: string[] = [];
      for (const cpp of cpps) {
        const obj = cpp.replace(/\.cpp$/, ".o");
        const c = gxx([...RUNTIME_FLAGS, `-I${RUNTIME_INCLUDE_PATH}`, `-I${dir}`, "-c", cpp, "-o", obj]);
        expect(c.ok, c.out).toBe(true);
        syms.push(execFileSync("nm", [obj], { encoding: "utf8" }));
      }
      expect(syms.join("\n"), label).not.toMatch(PROBE_MARKERS);
      // The one probe-related symbol a probe-off build keeps: the NO_PROBES answer.
      expect(cppOf(off)).toMatch(/strucpp_dbg_probe_count\(void\) \{ return 0; \}/);

      const on = build(src);
      expect(cppOf(on)).toMatch(PROBE_MARKERS);
    }
  });

  it("A019: probe-off links with no debug ABI, reports zero probes, and watch and force still work", () => {
    const off = build(PLANT, { debugProbes: false, md5: "x" });
    expect(off.debugTableCpp).toBeDefined();
    const leaf = (p: string) => off.debugMap!.leaves.find((l) => l.path === p)!;
    const count = leaf("INSTANCE0.COUNT");
    const out1 = leaf("INSTANCE0.OUT1");
    const in1 = leaf("INSTANCE0.IN1");
    const main = `
#include "generated.hpp"
#include "debug_dispatch.hpp"
#include <cstdio>
#include <cstring>
strucpp::Configuration_CONFIG0 g_config;
extern "C" uint32_t strucpp_dbg_probe_count(void);
using namespace strucpp;
static long rd(uint8_t a, uint16_t e, int n) { uint8_t b[8] = {0}; debug::handle_read(a, e, b); long v = 0; std::memcpy(&v, b, n); return v; }
int main() {
  g_config.INSTANCE0.IN1 = 7;
  for (int s = 0; s < 3; ++s) g_config.INSTANCE0.run();
  int16_t forced = 99;
  uint8_t st = debug::handle_set(${out1.arrayIdx}, ${out1.elemIdx}, true, reinterpret_cast<const uint8_t*>(&forced), 2);
  for (int s = 0; s < 2; ++s) g_config.INSTANCE0.run();
  std::printf("probes=%u count=%ld in1=%ld out1=%ld set=%u\\n", strucpp_dbg_probe_count(),
    rd(${count.arrayIdx}, ${count.elemIdx}, 4), rd(${in1.arrayIdx}, ${in1.elemIdx}, 2),
    rd(${out1.arrayIdx}, ${out1.elemIdx}, 2), st);
  return 0;
}
`;
    // No debug_probe_stub.hpp: a probe-off build must not need the debug ABI.
    const res = buildAndRun("a019", off, main, {
      extraCpp: { "generated_debug.cpp": off.debugTableCpp! },
    });
    expect(res.out).toContain("probes=0 count=5 in1=7 out1=99 set=0");
  });
});

// ---------------------------------------------------------------------------
// Transfer: arm mid-loop, continue in the probed clone.
// ---------------------------------------------------------------------------

const TRANSFER = `
FUNCTION SumTo : DINT
  VAR_INPUT n : DINT; END_VAR
  VAR i : DINT; acc : DINT; END_VAR
  FOR i := 1 TO n DO
    acc := acc + i;                                         (*@FN_BODY*)
    {external void test_hook(long long); test_hook(I.get()); }
  END_FOR;
  SumTo := acc;
END_FUNCTION

FUNCTION_BLOCK Twice
  VAR_INPUT x : DINT; END_VAR
  VAR_OUTPUT y : DINT; END_VAR
  y := x * 2;
  {external void test_hook(long long); test_hook(X.get()); }
END_FUNCTION_BLOCK

FUNCTION_BLOCK Leaf
  VAR_INPUT x : DINT; END_VAR
  VAR_OUTPUT y : DINT; END_VAR
  y := x + 1;                                               (*@LEAF_BODY*)
END_FUNCTION_BLOCK

PROGRAM FnLoop
  VAR r : DINT; END_VAR
  r := SumTo(1000);
END_PROGRAM

PROGRAM PrgLoop
  VAR k : DINT; total : DINT; END_VAR
  FOR k := 1 TO 1000 DO
    total := total + k;                                     (*@PRG_BODY*)
    {external void test_hook(long long); test_hook(K.get()); }
  END_FOR;
END_PROGRAM

PROGRAM CallRet
  VAR k : DINT; total : DINT; c : Twice; END_VAR
  FOR k := 1 TO 10 DO
    c(x := k);
    total := total + c.y;                                   (*@AFTER_CALL*)
  END_FOR;
END_PROGRAM

PROGRAM LeafLoop
  VAR k : DINT; total : DINT; l : Leaf; END_VAR
  FOR k := 1 TO 10 DO
    l(x := k);
    total := total + l.y;
    {external void test_hook(long long); test_hook(K.get()); }
  END_FOR;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK t0(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM p1 WITH t0 : FnLoop;
    PROGRAM p2 WITH t0 : PrgLoop;
    PROGRAM p3 WITH t0 : CallRet;
    PROGRAM p4 WITH t0 : LeafLoop;
  END_RESOURCE
END_CONFIGURATION
`;

const TRANSFER_MAIN = `
#include "generated.hpp"
#include "debug_probe_stub.hpp"
#include <cstdio>
#include <cstdlib>
#include <cstring>
namespace strucpp {
long long g_arm_at = -1, g_last = 0, g_last_at_first_stop = -1;
uint32_t g_arm_probe = 0;
void test_hook(long long v) {
  g_last = v;
  if (v == g_arm_at) { dbg::stub::attach(); dbg::stub::arm(g_arm_probe); }
}
}
using namespace strucpp;
static void on_stop(uint32_t, const strucpp_dbg_frame*) {
  if (g_last_at_first_stop < 0) g_last_at_first_stop = g_last;
}
int main(int argc, char** argv) {
  const char* which = argv[1];
  g_arm_probe = (uint32_t)std::atoi(argv[2]);
  g_arm_at = std::atoll(argv[3]);
  dbg::stub::set_on_stop(on_stop);
  long long result = 0;
  if (!std::strcmp(which, "fn")) { Program_FNLOOP p; p.run(); result = p.R.get(); }
  else if (!std::strcmp(which, "prg")) { Program_PRGLOOP p; p.run(); result = p.TOTAL.get(); }
  else if (!std::strcmp(which, "call")) { Program_CALLRET p; p.run(); result = p.TOTAL.get(); }
  else { Program_LEAFLOOP p; p.run(); result = p.TOTAL.get(); }
  std::printf("stops=%u first_at=%lld result=%lld\\n", dbg::stub::stops(g_arm_probe), g_last_at_first_stop, result);
  return 0;
}
`;

describe.skipIf(!hasGpp)("transfer: arming mid-loop continues in the probed clone with the same locals", () => {
  // Expected outcome per scenario; "first_at" is the last loop value seen
  // before the first stop, so 500 means the stop came on the iteration right
  // after the arm, not after a restart at the POU entry.
  const SCENARIOS = [
    { id: "fn", marker: "FN_BODY", armAt: 500, expect: "stops=500 first_at=500 result=500500" },
    { id: "prg", marker: "PRG_BODY", armAt: 500, expect: "stops=500 first_at=500 result=500500" },
    // Armed inside Twice for x = 5: the caller transfers at the call return.
    { id: "call", marker: "AFTER_CALL", armAt: 5, expect: "stops=6 first_at=5 result=110" },
    // Armed at k = 5: the leaf stops on every later call (k = 6..10).
    { id: "leaf", marker: "LEAF_BODY", armAt: 5, expect: "stops=5 first_at=5 result=65" },
  ];

  const builds = [
    { name: "default", opts: {} as Partial<CompileOptions> },
    { name: "leaf-rule", opts: { debugProbeLeafRule: true } as Partial<CompileOptions> },
  ];

  for (const b of builds) {
    it(`${b.name} build: every scenario continues at the poll site`, () => {
      const r = build(TRANSFER, b.opts);
      const { dir, cpps } = writeTree(`xfer-${b.name}`, r);
      const main = path.join(dir, "main.cpp");
      fs.writeFileSync(main, TRANSFER_MAIN);
      const bin = path.join(dir, "a.out");
      const c = gxx([...RUNTIME_FLAGS, "-pthread", `-I${RUNTIME_INCLUDE_PATH}`, `-I${TEST_RUNTIME_PATH}`, `-I${dir}`, main, ...cpps, "-o", bin]);
      expect(c.ok, c.out).toBe(true);
      for (const s of SCENARIOS) {
        const probe = probeAt(TRANSFER, r, s.marker);
        const out = execFileSync(bin, [s.id, String(probe), String(s.armAt)], { encoding: "utf8" });
        expect(out.trim(), `${b.name} ${s.id}`).toBe(s.expect);
      }
    });
  }

  // Each red build breaks one part of the transfer; at least one scenario
  // must then disagree with the green expectation.
  const REDS: Array<{ name: string; opts: Partial<CompileOptions>; patch: (c: string) => string }> = [
    {
      name: "no back-edge or call-return polls",
      opts: {},
      patch: (c) => c.split("\n").filter((l) => !/^\s*STRUCPP_POLL\([1-9]\d*, /.test(l)).join("\n"),
    },
    {
      name: "every transfer restarts at the POU entry",
      opts: {},
      patch: (c) => c.replace(/(STRUCPP_POLL\(\d+, \w*__dbg_probed\()\d+/g, "$10"),
    },
    {
      name: "leaf rule with probed callers calling the unprobed leaf",
      opts: { debugProbeLeafRule: true },
      patch: (c) => c.replace(/\.__dbg_probed\(0\)/g, "()"),
    },
  ];
  for (const red of REDS) {
    it(`red: ${red.name}`, () => {
      const r = build(TRANSFER, red.opts);
      const slug = red.name.replace(/\W+/g, "-");
      const { dir, cpps } = writeTree(`xfer-red-${slug}`, r, red.patch);
      const main = path.join(dir, "main.cpp");
      fs.writeFileSync(main, TRANSFER_MAIN);
      const bin = path.join(dir, "a.out");
      const c = gxx([...RUNTIME_FLAGS, "-pthread", `-I${RUNTIME_INCLUDE_PATH}`, `-I${TEST_RUNTIME_PATH}`, `-I${dir}`, main, ...cpps, "-o", bin]);
      expect(c.ok, c.out).toBe(true);
      const wrong = SCENARIOS.filter((s) => {
        const probe = probeAt(TRANSFER, r, s.marker);
        const out = execFileSync(bin, [s.id, String(probe), String(s.armAt)], { encoding: "utf8" });
        return out.trim() !== s.expect;
      });
      expect(wrong.length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Probed clones run whole programs correctly: the validation suite, attached.
// ---------------------------------------------------------------------------

describe.skipIf(!hasGpp)("probed clones: validation programs pass with a session attached from the start", () => {
  const PAIRS = [
    "control_flow/nested_loops",
    "functions/function_calls",
    "function_blocks/fb_methods",
    "function_blocks/fb_properties",
    "function_blocks/fb_inheritance",
  ];
  for (const pair of PAIRS) {
    const src = path.join(VALIDATION_DIR, `${pair}.st`);
    const test = path.join(VALIDATION_DIR, path.dirname(pair), `test_${path.basename(pair)}.st`);
    it.skipIf(!fs.existsSync(src) || !fs.existsSync(test))(`${pair}: attached and trap-all`, () => {
      for (const mode of ["attach", "trap"]) {
        const res = runE2ETestPipeline({
          sourceST: fs.readFileSync(src, "utf8"),
          testST: fs.readFileSync(test, "utf8"),
          testFileName: path.basename(test),
          isTestBuild: true,
          compileOptions: { libraries: [IEC_STDLIB] },
          env: { STRUCPP_DBG_STUB: mode },
        });
        expect(res.exitCode, `${pair} ${mode}\n${res.stdout}`).toBe(0);
        expect(res.stdout).toMatch(new RegExp(`strucpp-dbg-stub: ${mode} stops=${mode === "trap" ? "[1-9]" : "0"}`));
      }
    });
  }
});

// ---------------------------------------------------------------------------
// A204: shared-global lock sites S1-S8.
// ---------------------------------------------------------------------------

// The openplc-runtime corpus program corpus:shared-globals, verbatim apart
// from comments.
const SHARED = `
FUNCTION F : INT
  VAR_INPUT
    i : INT;
  END_VAR
  F := i MOD 4;                                            (*@F_BODY*)
END_FUNCTION

FUNCTION_BLOCK Gauge
  VAR
    level : DINT;
  END_VAR
  PROPERTY PUBLIC P : DINT
    GET
      P := level;                                          (*@GETTER*)
    END_GET
  END_PROPERTY
END_FUNCTION_BLOCK

FUNCTION_BLOCK Pulse
  VAR_INPUT
    IN : INT;
  END_VAR
  VAR_OUTPUT
    Q : DINT;
  END_VAR
  Q := INT_TO_DINT(IN) + 1;
END_FUNCTION_BLOCK

PROGRAM ProgA
  VAR
    witness AT %QD0 : DINT;
    out_x AT %QD2 : DINT;
    i : INT;
    x : DINT;
    y : DINT;
    z : DINT;
    units : ARRAY[0..3] OF Pulse;
  END_VAR
  VAR_EXTERNAL
    G_ARR : ARRAY[0..7] OF DINT;
    G_A : ARRAY[0..3] OF DINT;
    G_B : ARRAY[0..3] OF INT;
    G_W : ARRAY[0..3] OF WORD;
    G_S : DINT;
    G_FB : Gauge;
  END_VAR
  witness := witness + 1;                                  (*@A_WITNESS*)
  y := G_S;                                                (*@S1*)
  G_S := INT_TO_DINT(F(i));                                (*@S2*)
  units[0](IN := F(i), Q => G_S);                          (*@S3*)
  x := G_FB.P;                                             (*@S4*)
  x := x + G_ARR[F(i)];                                    (*@S4_ARR*)
  G_ARR[F(i)] := x;                                        (*@S5*)
  G_W[F(i)].3 := TRUE;                                     (*@S6*)
  units[F(i)](IN := 1, Q => G_ARR[1]);                     (*@S7*)
  z := G_A[G_B[1]];                                        (*@NESTED*)
  out_x := x + y + z;
  i := i + 1;                                              (*@A_LAST*)
END_PROGRAM

PROGRAM ProgB
  VAR
    witness AT %QD1 : DINT;
    k : INT;
  END_VAR
  VAR_EXTERNAL
    G_ARR : ARRAY[0..7] OF DINT;
  END_VAR
  witness := witness + 1;                                  (*@B_WITNESS*)
  G_ARR[k] := G_ARR[k] + 1;                                (*@B_RW*)
  k := (k + 1) MOD 8;
END_PROGRAM

CONFIGURATION Config0
  VAR_GLOBAL
    G_ARR : ARRAY[0..7] OF DINT;
    G_A : ARRAY[0..3] OF DINT := [10, 11, 12, 13];
    G_B : ARRAY[0..3] OF INT := [0, 1, 2, 3];
    G_W : ARRAY[0..3] OF WORD;
    G_S : DINT;
    G_FB : Gauge;
  END_VAR
  RESOURCE Res0 ON PLC
    TASK TaskA(INTERVAL := T#20ms, PRIORITY := 1);
    TASK TaskB(INTERVAL := T#10ms, PRIORITY := 2);
    PROGRAM PROG_A WITH TaskA : ProgA;
    PROGRAM PROG_B WITH TaskB : ProgB;
  END_RESOURCE
END_CONFIGURATION
`;

/** Every `with_lock` lambda body in the code, with its nesting resolved. */
function lockLambdas(code: string): string[] {
  const out: string[] = [];
  const re = /with_lock\(\[&\]\(auto\* __glk\)\{/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}") depth--;
    }
    out.push(code.slice(start, i - 1));
  }
  return out;
}

/** Subscripts inside a lock lambda: literal, plain local, or a hoisted temp. */
const SAFE_INDEX = /^(\d+|[A-Z_][A-Z0-9_]*|__gi_\d+|__gcs_\d+)$/;

function inspectLockSites(code: string): string[] {
  const problems: string[] = [];
  for (const body of lockLambdas(code)) {
    if (/STRUCPP_PROBE|STRUCPP_POLL/.test(body)) problems.push(`probe in lock: ${body}`);
    if (/with_lock|->read\(|->write\(/.test(body)) problems.push(`nested lock: ${body}`);
    for (const m of body.matchAll(/\.at\(([^()]*(?:\([^()]*\))*[^()]*)\)/g)) {
      for (const idx of m[1]!.split(",").map((s) => s.trim())) {
        if (!SAFE_INDEX.test(idx)) problems.push(`unhoisted subscript ${idx}: ${body}`);
      }
    }
    // Calls other than .at( and one trailing .get_<P>() of a read tail.
    const calls = [...body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)]
      .map((c) => c[1]!)
      .filter((c) => !["at", "static_cast", "return", "uint64_t"].includes(c));
    const getters = calls.filter((c) => /^get_/.test(c));
    const others = calls.filter((c) => !/^get_/.test(c));
    if (others.length > 0) problems.push(`call ${others.join(",")} in lock: ${body}`);
    if (getters.length > 1 || (getters.length === 1 && !/\.get_\w+\(\);?\s*$/.test(body.trim())))
      problems.push(`getter not last in read tail: ${body}`);
  }
  return problems;
}

const A204_MAIN = `
#include "generated.hpp"
#include "debug_probe_stub.hpp"
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <thread>
#include <unistd.h>
using namespace strucpp;
static Configuration_CONFIG0* cfg;
static std::mutex m;
static std::condition_variable cv;
static bool parked = false, released = false;
static int parks = 0, b_runs = 0;
static void on_stop(uint32_t, const strucpp_dbg_frame*) {
  std::unique_lock<std::mutex> lk(m);
  parked = true; ++parks;
  cv.notify_all();
  cv.wait(lk, [] { return released; });
  released = false; parked = false;
}
// Task B runs one scan while task A is parked; if A parked holding a lock B
// needs, B never finishes and the process reports it instead of hanging.
static void run_b_or_die() {
  std::atomic<bool> done(false);
  std::thread b([&] { cfg->PROG_B.run(); done = true; });
  for (int t = 0; t < 400 && !done; ++t) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  if (!done) { std::printf("B_BLOCKED parks=%d\\n", parks); std::fflush(stdout); _exit(3); }
  b.join(); ++b_runs;
}
int main(int argc, char** argv) {
  static Configuration_CONFIG0 c; cfg = &c;
  dbg::stub::set_on_stop(on_stop);
  dbg::stub::attach();
  for (int a = 1; a < argc; ++a) dbg::stub::arm((uint32_t)std::atoi(argv[a]));
  for (int rep = 0; rep < 20; ++rep) {
    std::atomic<bool> a_done(false);
    std::thread ta([&] { cfg->PROG_A.run(); a_done = true; });
    for (;;) {
      std::unique_lock<std::mutex> lk(m);
      cv.wait_for(lk, std::chrono::milliseconds(5), [] { return parked; });
      if (parked && !released) { lk.unlock(); run_b_or_die(); lk.lock(); released = true; cv.notify_all(); }
      else if (a_done) break;
    }
    ta.join();
  }
  uint32_t stops = 0, skips = 0;
  for (int a = 1; a < argc; ++a) { stops += dbg::stub::stops((uint32_t)std::atoi(argv[a])); skips += dbg::stub::skips((uint32_t)std::atoi(argv[a])); }
  std::printf("parks=%d stops=%u skips=%u b_runs=%d\\n", parks, stops, skips, b_runs);
  return 0;
}
`;

describe("A204: no probe parks under a shared-global lock (S1-S8)", () => {
  it("build-inspect: lock lambdas hold no probe, no second lock, no call but .at and a final getter; subscripts and the S7 source are hoisted", () => {
    const r = build(SHARED);
    const code = r.cppFiles.find((f) => f.name === "pou_PROGA.cpp")!.content;
    expect(lockLambdas(code).length).toBeGreaterThanOrEqual(6);
    expect(inspectLockSites(code)).toEqual([]);
    // S7: the capture source is a temp assigned before the lock.
    expect(code).toMatch(/auto (__gcs_\d+) = UNITS\.at\(__gi_\d+\)\.Q;\s*\n\s*G_ARR->with_lock\(\[&\]\(auto\* __glk\)\{ \(\*__glk\)\.at\(1\) = \1; \}\);/);
    // S4 with a call subscript: the subscript is computed in an immediately invoked lambda.
    expect(code).toMatch(/\[&\]\{ auto (__gi_\d+) = F\(I\); return G_ARR->with_lock\(\[&\]\(auto\* __glk\)\{ return \(\*__glk\)\.at\(\1\); \}\); \}\(\)/);
  });

  it("red: with the hoist disabled, the build-inspect finds calls and nested locks inside lock lambdas", () => {
    const r = build(SHARED, { testOnlyDisableLockHoist: true });
    const code = r.cppFiles.find((f) => f.name === "pou_PROGA.cpp")!.content;
    const problems = inspectLockSites(code).join("\n");
    expect(problems).toMatch(/call F in lock/);
    expect(problems).toMatch(/nested lock/);
  });

  it("refuses a property read through a shared global whose getter's FB declares a VAR_EXTERNAL, and the shared-FB call (S8)", () => {
    const getter = SHARED.replace(
      "  VAR\n    level : DINT;\n  END_VAR\n  PROPERTY",
      "  VAR\n    level : DINT;\n  END_VAR\n  VAR_EXTERNAL\n    G_S : DINT;\n  END_VAR\n  PROPERTY",
    );
    expect(() => compile(getter, { headerFileName: "generated.hpp" })).toThrow(/getter.*VAR_EXTERNAL|VAR_EXTERNAL.*getter/i);
    const s8 = SHARED.replace("  out_x := x + y + z;", "  out_x := x + y + z;\n  G_FB();");
    expect(() => compile(s8, { headerFileName: "generated.hpp" })).toThrow(/shared function-block global/i);
  });

  describe.skipIf(!hasGpp)("two tasks against the stub host (STRUCPP_THREADED)", () => {
    let fBody = 0;
    let getterProbe = 0;
    const runA204 = (name: string, opts: Partial<CompileOptions>, include?: string) => {
      const r = build(SHARED, opts);
      fBody = probeAt(SHARED, r, "F_BODY");
      getterProbe = probeAt(SHARED, r, "GETTER");
      const { dir, cpps } = writeTree(`a204-${name}`, r);
      const main = path.join(dir, "main.cpp");
      fs.writeFileSync(main, A204_MAIN);
      const bin = path.join(dir, "a.out");
      const c = gxx([...RUNTIME_FLAGS, "-pthread", `-I${include ?? RUNTIME_INCLUDE_PATH}`, `-I${TEST_RUNTIME_PATH}`, `-I${dir}`, main, ...cpps, "-o", bin]);
      expect(c.ok, c.out).toBe(true);
      return (probes: number[]) => {
        const res = spawnSync(bin, probes.map(String), { encoding: "utf8", timeout: 30000 });
        return { status: res.status, out: `${res.stdout}${res.stderr}`.trim() };
      };
    };
    it("default build: every hit in F parks with no lock held and task B always completes; the getter hit is skipped", () => {
      const run = runA204("default", {});
      const f = run([fBody]);
      expect(f.status, f.out).toBe(0);
      // F runs several times per scan (S2, S3, S4_ARR, S5, S6, and S7 renders
      // the element per input, call, ENO and capture); every one of them parks.
      const m = /^parks=(\d+) stops=\1 skips=0 b_runs=\1$/.exec(f.out);
      expect(m, f.out).not.toBeNull();
      expect(Number(m![1]) % 20).toBe(0);
      expect(Number(m![1]) / 20).toBeGreaterThanOrEqual(6);
      const g = run([getterProbe]);
      expect(g.status, g.out).toBe(0);
      expect(g.out).toBe("parks=0 stops=0 skips=20 b_runs=0");
    });

    it("hoist-disabled build: hits under a lock are skipped (defence 2 alone) and task B always completes", () => {
      const run = runA204("nohoist", { testOnlyDisableLockHoist: true });
      const f = run([fBody]);
      expect(f.status, f.out).toBe(0);
      // S2 and S3 evaluate F before the lock; S4_ARR, S5, S6 and S7's capture
      // index run F under a lock, so those hits are skipped.
      expect(f.out).toMatch(/^parks=(\d+) stops=\1 skips=([1-9]\d*) b_runs=\1$/);
    });

    it("red: hoist disabled and GlobalVar's lock-depth increment dropped, a probe parks under the lock and task B blocks", () => {
      const rt = patchedRuntime("nodepth", "iec_global.hpp", "{ ++lock_depth(); }", "{}");
      const run = runA204("nodepth", { testOnlyDisableLockHoist: true }, rt);
      const f = run([fBody]);
      expect(f.out).toMatch(/B_BLOCKED/);
      expect(f.status).toBe(3);
    });
  });
});
