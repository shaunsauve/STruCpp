/**
 * Debugger probes in the generated C++: the per-POU dual path (an unprobed
 * clone with call-free polls and a probed clone entered by on-stack transfer),
 * the probe-off build, and the shared-global lock rule.
 *
 * Each block names the acceptance criterion it evidences:
 *   - shape        : the unprobed clone is the probe-off output plus polls, and
 *                    every planned probe is emitted once, in a probed clone.
 *   - A027         : every planted poll is accounted for in the object code
 *                    (found in the poll shape, or proven unreachable) on the
 *                    local toolchain, its x86-64 target on an arm64 Mac, and
 *                    GCC 12 linux/arm64 and linux/amd64 when docker is present.
 *   - A028 / A019  : probe-off has no probe code, links without the debug ABI,
 *                    and still serves watch and force through the debug table.
 *   - transfer     : arming mid-loop continues in the probed clone with the same
 *                    locals, on GCC 12 arm64 (asm handoff) and amd64 (C++
 *                    fallback) too; broken transfers (no polls, restart at
 *                    entry, leaf called unprobed) are shown red.
 *
 * Probe-on blocks skip when compile()'s default is probe-off and the
 * probe-off-configuration test skips when it is probe-on (PROBES_ON).
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
    .filter((l) => !/__dbg_(probed|entry|xfer)\(/.test(l))
    .map((l) => l.replace(/^STRUCPP_DBG_UNPROBED /, ""))
    .join("\n");
}

function cppOf(r: Result): string {
  return r.cppFiles.map((f) => `//// ${f.name}\n${f.content}`).join("\n");
}

/**
 * The probe configuration of this run: whether `compile()` plants probes when
 * the caller does not say. Probe-on tests skip when it is off and the
 * probe-off-configuration test skips when it is on, so the suite is green in
 * both configurations with the other side reported as skipped.
 */
const PROBES_ON = /STRUCPP_POLL\(/.test(cppOf(compile(
  "PROGRAM P\n  VAR i : INT; END_VAR\n  i := i + 1;\nEND_PROGRAM\n",
  { headerFileName: "generated.hpp" },
)));
const PROBE_CONFIG = `probe configuration: ${PROBES_ON ? "on" : "off"}`;

describe.skipIf(!PROBES_ON)(`probe-on codegen: per-POU dual path (ADR-001 D10.6, A″ form) (${PROBE_CONFIG})`, () => {
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
    // Functions hand over their parameters and locals by value: the probed
    // clone's call, and the transfer stub's state (parameters and result by
    // address, locals encoded) for the register-saving form.
    const sum = r.cppFiles.find((f) => f.name === "pou_SUMTO.cpp")!.content;
    expect(sum).toMatch(new RegExp(
      "STRUCPP_POLL\\((\\d+), SUMTO__dbg_probed\\(\\1, N, I, ACC, TMP, SUMTO_result\\), 7, SUMTO__dbg_xfer, " +
      "&SUMTO_result, SUMTO_result, STRUCPP_XP\\(N\\), STRUCPP_XA\\(I\\), STRUCPP_XA\\(ACC\\), STRUCPP_XA\\(TMP\\), " +
      "STRUCPP_XP\\(SUMTO_result\\)\\);"));
    expect(sum).toContain("void SUMTO__dbg_xfer(const uint64_t* __s) {");
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
// GCC 12 images: the openplc-runtime toolchain (debian bookworm), per platform.
// linux/arm64 is the reference target; linux/amd64 is what x86-64 CI runs.
// ---------------------------------------------------------------------------

const GCC12_DOCKERFILE = path.resolve(__dirname, "docker/gcc12-arm64.Dockerfile");
const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 20000 }).status === 0;
type Platform = "linux/arm64" | "linux/amd64";
const gcc12Image = (platform: Platform): string => `strucpp-gcc12-${platform.split("/")[1]}:local`;
const gcc12Built = new Set<Platform>();

/** Build (or reuse) the GCC 12 image for `platform`. The Dockerfile pins a multi-arch digest. */
function ensureGcc12(platform: Platform): string {
  if (!gcc12Built.has(platform)) {
    const b = spawnSync("docker", [
      "build", "-q", "--platform", platform, "-t", gcc12Image(platform),
      "-f", GCC12_DOCKERFILE, path.dirname(GCC12_DOCKERFILE),
    ], { encoding: "utf8", timeout: 900000 });
    expect(`${b.stdout}${b.stderr}`, "docker build").toBe(b.status === 0 ? `${b.stdout}${b.stderr}` : "<built>");
    gcc12Built.add(platform);
  }
  return gcc12Image(platform);
}

/** Run `script` in the GCC 12 image with `root` at /w. */
function inGcc12(platform: Platform, root: string, script: string, mounts: string[] = []): void {
  const res = spawnSync("docker", [
    "run", "--rm", "--platform", platform, "--cpus", "2", "-v", `${root}:/w`,
    ...mounts.flatMap((m) => ["-v", m]), ensureGcc12(platform), "sh", "-c", `set -e\n${script}`,
  ], { encoding: "utf8", maxBuffer: 64 << 20, timeout: 900000 });
  expect(`${res.stdout}${res.stderr}`, `gcc 12 ${platform}`).toBe(res.status === 0 ? `${res.stdout}${res.stderr}` : "<ok>");
}

// ---------------------------------------------------------------------------
// A027: poll shape in the object code, accounted per planted site.
//
// Every STRUCPP_POLL line the codegen planted must end in exactly one of:
//   found       one or more active-byte loads attributed to that line (DWARF
//               line table), each in the poll shape: arm64 `ldrb wN` whose
//               next use of wN is `tbnz|tbz wN, #0` (independent instructions
//               the scheduler interleaves are allowed and listed); x86-64
//               `testb $1, active` + jcc, or a byte load, one test, one jcc;
//   unreachable no active load AND no call in a reachability build, where the
//               same line is replaced by an opaque external call. A reachable
//               call is never deleted, so its absence proves the compiler
//               removed the site as dead code.
// Anything else fails: a site missing while reachable, a load in another
// shape, an active load attributed to no planted line, a slow-path call.
// The load is volatile, so the compiler may not merge two sites into one
// load; duplication (several loads on one line) is allowed and reported.
//
// The line mapping needs -g. -g must not change code generation; each object
// is also built without -g and the instruction streams must be identical.
// ---------------------------------------------------------------------------

type Arch = "arm64" | "x86_64";
interface Insn { addr: number; mn: string; ops: string; relocs: string[]; fn: string; file: string; line: number }

/** objdump -d -r -l (GNU or LLVM, ELF or Mach-O) into instructions with function, file and line. */
function parseDis(dis: string): Insn[] {
  const out: Insn[] = [];
  let fn = "";
  let file = "";
  let line = 0;
  for (const raw of dis.split("\n")) {
    const t = raw.trim();
    const head = /^[0-9a-f]+ <(.+)>:$/.exec(t);
    if (head) {
      fn = head[1]!.replace(/^_(?=_Z)/, "");
      file = "";
      line = 0;
      continue;
    }
    // LLVM labels the first function of a Mach-O section `ltmpN`; its -l
    // function marker carries the real name.
    const marker = /^(?:; )?([\w.$]+)\(\):$/.exec(t);
    if (marker) {
      if (/^ltmp\d+$/.test(fn)) fn = marker[1]!;
      continue;
    }
    const loc = /^(?:; )?(\/\S+):(\d+)(?: \(discriminator \d+\))?$/.exec(t);
    if (loc) {
      file = path.basename(loc[1]!);
      line = Number(loc[2]);
      continue;
    }
    const reloc = /^\s*[0-9a-f]+:\s+(R_\S+|ARM64_RELOC_\S+|X86_64_RELOC_\S+)\s+_?([\w.$]+)/.exec(raw);
    if (reloc) {
      out[out.length - 1]?.relocs.push(reloc[2]!);
      continue;
    }
    const m = /^\s*([0-9a-f]+):\s+(\S+)\s*(.*)$/.exec(raw);
    if (m) {
      const ops = m[3]!.replace(/\s+(\/\/|;|##? ).*$/, "").trim();
      out.push({ addr: parseInt(m[1]!, 16), mn: m[2]!, ops, relocs: [], fn, file, line });
    }
  }
  return out;
}

/** Instruction lines only, for the -g / no -g code-identity check. */
const insnText = (dis: string): string[] =>
  dis.split("\n")
    .filter((l) => /^\s*[0-9a-f]+:\s+\S/.test(l) && !/^\s*[0-9a-f]+:\s+(R_|ARM64_RELOC_|X86_64_RELOC_)/.test(l))
    .map((l) => l.trim().replace(/\s+/g, " "));

/** Probed clones, leaf entries, transfer stubs and the frame record run only with a session attached. */
const SESSION_ONLY = /__dbg_(probed|entry|xfer)|dbg5Frame|clang_call_terminate/;
const ACTIVE = "strucpp_dbg_active";
const isActive = (i: Insn): boolean => i.relocs.some((r) => r.startsWith(ACTIVE));
const isCallOrJump = (i: Insn): boolean => /^(bl|b|blr|br|call[q]?|jmp[q]?)$/.test(i.mn);

interface Load { site: string; how: string; shape: string | undefined; text: string }

/** Every active-byte load in session-free code, with its line and shape verdict. */
function activeLoads(arch: Arch, insns: Insn[]): { loads: Load[]; slowCalls: string[] } {
  const loads: Load[] = [];
  const slowCalls: string[] = [];
  const byFn = new Map<string, Insn[]>();
  for (const i of insns) {
    if (SESSION_ONLY.test(i.fn)) continue;
    if (!byFn.has(i.fn)) byFn.set(i.fn, []);
    byFn.get(i.fn)!.push(i);
  }
  for (const [, fi] of byFn) {
    // arm64: a load through a register holding &strucpp_dbg_active, formed by
    // adrp + add (GCC hoists it out of a loop and loads `ldrb wN, [xR]` with no
    // relocation of its own). The register counts only if every CFG path back
    // from the load reaches that add before any other write or call clobber.
    const at = new Map(fi.map((x, k) => [x.addr, k]));
    const target = (x: Insn): number | undefined => {
      const t = /\b(?:0x)?([0-9a-f]+) <[^>]*>$/.exec(x.ops);
      return t ? at.get(parseInt(t[1]!, 16)) : undefined;
    };
    const preds: number[][] = fi.map(() => []);
    fi.forEach((x, k) => {
      const t = target(x);
      const cond = /^(cbz|cbnz|tbz|tbnz)$|^b\./.test(x.mn);
      if ((x.mn === "b" || cond) && t !== undefined) preds[t]!.push(k);
      if (!/^(b|ret|br)$/.test(x.mn) && k + 1 < fi.length) preds[k + 1]!.push(k);
    });
    const writes = (x: Insn, reg: number): boolean => {
      if (/^(bl|blr)$/.test(x.mn)) return reg <= 18 || reg === 30;
      if (/^(st|cmp|cmn|tst|cb|tb|b|ret|br|prfm)/.test(x.mn)) return false;
      const d = /^[xw](\d+)(?:, [xw](\d+))?/.exec(x.ops);
      return !!d && (Number(d[1]) === reg || (/^ldp/.test(x.mn) && Number(d[2]) === reg));
    };
    const holdsActive = (n: number, reg: number): boolean => {
      const seen = new Set<number>();
      const work = [...preds[n]!];
      if (n === 0) return false;
      while (work.length) {
        const k = work.pop()!;
        if (seen.has(k)) continue;
        seen.add(k);
        const x = fi[k]!;
        if (writes(x, reg)) {
          if (x.mn === "add" && isActive(x)) continue;
          return false;
        }
        if (k === 0) return false; // function entry with no definition
        work.push(...preds[k]!);
      }
      return seen.size > 0;
    };
    fi.forEach((ins, n) => {
      const site = `${ins.file}:${ins.line}`;
      if (isCallOrJump(ins) && ins.relocs.concat(ins.ops).some((s) => /strucpp_dbg_(hit|frame_link|test_poll)/.test(s))) {
        slowCalls.push(`${site} ${ins.mn} ${ins.ops}`);
      }
      const text = (k: number): string => fi.slice(n, n + k).map((x) => `${x.mn} ${x.ops}`).join(" ; ");
      if (arch === "arm64") {
        const base = /\[x(\d+)(?:, #0x0|, #0)?\]$/.exec(ins.ops)?.[1];
        const viaReg = base !== undefined && /^ld/.test(ins.mn) && !isActive(ins) && holdsActive(n, Number(base));
        if (!(isActive(ins) && /^ld/.test(ins.mn)) && !viaReg) return;
        const how = isActive(ins) ? "direct" : `address hoisted in x${base}`;
        if (ins.mn !== "ldrb") {
          loads.push({ site, how, shape: `not a byte load: ${text(2)}`, text: text(2) });
          return;
        }
        const reg = /^w(\d+),/.exec(ins.ops)![1]!;
        const uses = new RegExp(`\\b[wx]${reg}\\b`);
        let shape: string | undefined = "no test of the loaded byte";
        let len = 1;
        for (let j = n + 1; j < fi.length && j <= n + 8; j++) {
          const o = fi[j]!;
          len++;
          if (uses.test(o.ops)) {
            shape = /^(tbnz|tbz)$/.test(o.mn) && new RegExp(`^w${reg}, #(0x0|0),`).test(o.ops)
              ? undefined
              : `loaded byte used by \`${o.mn} ${o.ops}\` before any tbnz/tbz`;
            break;
          }
          if (/^(b|bl|blr|br|ret|cbz|cbnz|tbz|tbnz)$|^b\./.test(o.mn) || /^(ld|st)/.test(o.mn) && o.ops.includes(`[x${reg}`)) {
            shape = `poll split by \`${o.mn} ${o.ops}\``;
            break;
          }
        }
        loads.push({ site, how, shape, text: text(len) });
      } else {
        if (!isActive(ins) || /^lea/.test(ins.mn)) return;
        // x86-64: `testb $1, active(%rip)` then jcc, or a byte load into a
        // register, one `test|and $1` of it, then jcc. Independent mov/lea/add
        // the scheduler places in between are allowed and listed.
        const jcc = (m: string): boolean => /^j(ne|e|nz|z)$/.test(m);
        const setsNoFlags = (m: string): boolean => /^(mov|lea|nop)/.test(m);
        let want: "jcc" | "test" | undefined;
        let fam: RegExp | undefined;
        if (/^testb$/.test(ins.mn) && /^\$0x1,/.test(ins.ops)) want = "jcc";
        else if (/^(movzbl|movzbw|movb|movzx)$/.test(ins.mn)) {
          const r = /%(\w+)$/.exec(ins.ops)?.[1] ?? "";
          const k = /^r(\d+)/.exec(r)?.[1] ?? r.replace(/^[re]?([a-d])[xlh]$/, "$1").replace(/^[re]?(si|di|bp|sp)l?$/, "$1");
          fam = new RegExp(/^\d+$/.test(k) ? `%r${k}[dwb]?\\b` : /^[a-d]$/.test(k) ? `%[re]?${k}[xlh]\\b` : `%[re]?${k}l?\\b`);
          want = "test";
        }
        let shape: string | undefined = want ? "no branch on the loaded byte" : "not a testb or byte load of the active byte";
        let len = 1;
        for (let j = n + 1; want && j < fi.length && j <= n + 8; j++) {
          const o = fi[j]!;
          len++;
          if (want === "test") {
            if (fam!.test(o.ops)) {
              if (/^(test|and)[bl]?$/.test(o.mn) && /^\$0x1,/.test(o.ops)) { want = "jcc"; continue; }
              shape = `loaded byte used by \`${o.mn} ${o.ops}\` before a test`;
              break;
            }
            if (/^(j|call|ret)/.test(o.mn)) { shape = `poll split by \`${o.mn} ${o.ops}\``; break; }
            continue;
          }
          if (jcc(o.mn)) { shape = undefined; break; }
          if (!setsNoFlags(o.mn)) { shape = `test separated from its branch by \`${o.mn} ${o.ops}\``; break; }
        }
        loads.push({ site, how: "direct", shape, text: text(len) });
      }
    });
  }
  return { loads, slowCalls };
}

interface PollAudit { planted: number; failures: string[]; report: string[] }

/**
 * Account for every planted poll of one build. `dis` maps a .cpp basename to
 * its objects' disassembly: `g` (objdump -drl of the -g object), `plain`
 * (objdump -d without -g) and `reach` (the reachability build, -g).
 */
function auditPolls(
  arch: Arch,
  files: Array<{ name: string; content: string }>,
  dis: Map<string, { g: string; plain: string; reach: string }>,
): PollAudit {
  const failures: string[] = [];
  const report: string[] = [];
  const planted = new Map<string, number>(); // file:line -> poll label k
  for (const f of files) {
    f.content.split("\n").forEach((l, i) => {
      const m = /STRUCPP_POLL\((\d+),/.exec(l);
      if (m) planted.set(`${f.name}:${i + 1}`, Number(m[1]));
    });
  }
  const loads: Load[] = [];
  const reachable = new Set<string>();
  for (const f of files) {
    const d = dis.get(f.name);
    if (!d) {
      failures.push(`${f.name}: no object`);
      continue;
    }
    const g = insnText(d.g);
    const p = insnText(d.plain);
    const diff = g.findIndex((l, i) => l !== p[i]);
    if (diff >= 0 || g.length !== p.length) {
      failures.push(`${f.name}: -g changed the code at instruction ${diff}: ${g[diff]} vs ${p[diff]}`);
    }
    const a = activeLoads(arch, parseDis(d.g));
    loads.push(...a.loads);
    failures.push(...a.slowCalls.map((s) => `slow-path call on the idle path: ${s}`));
    for (const i of parseDis(d.reach)) {
      if (isCallOrJump(i) && i.relocs.concat(i.ops).some((s) => s.includes("strucpp_dbg_test_site"))) {
        reachable.add(`${i.file}:${i.line}`);
      }
    }
  }
  for (const l of loads) {
    if (!planted.has(l.site)) failures.push(`active load at ${l.site}, which is no planted poll: ${l.text}`);
  }
  let found = 0;
  let hoisted = 0;
  let unreachable = 0;
  for (const [site, k] of planted) {
    const at = loads.filter((l) => l.site === site);
    const label = `${site} poll ${k}`;
    if (at.length === 0) {
      if (reachable.has(site)) {
        failures.push(`${label}: reachable (its call survives in the reachability build) but has no active load`);
        report.push(`${label}: MISSING`);
      } else {
        unreachable++;
        report.push(`${label}: absent, unreachable (the reachability build drops its call too)`);
      }
      continue;
    }
    found++;
    if (at.some((l) => l.how !== "direct")) hoisted++;
    for (const l of at) {
      if (l.shape) failures.push(`${label}: ${l.shape}`);
    }
    report.push(`${label}: ${at.map((l) => `[${l.how}] ${l.text}${l.shape ? ` -- BAD: ${l.shape}` : ""}`).join(" || ")}`);
  }
  report.unshift(
    `${planted.size} planted: ${found} found (${found - hoisted} with the address formed at the load, ` +
      `${hoisted} through an address register hoisted out of the loop), ${unreachable} unreachable, ` +
      `${planted.size - found - unreachable} missing`,
  );
  return { planted: planted.size, failures, report };
}

/** The reachability build: every planted poll line replaced, in place, by an opaque call. */
const REACH_DECL = 'extern "C" void strucpp_dbg_test_site(unsigned);\n';
const reachPatch = (code: string): string =>
  code.split("\n").map((l, i) => (/STRUCPP_POLL\(/.test(l) ? `    strucpp_dbg_test_site(${i + 1}u);` : l)).join("\n");

interface ShapeToolchain { label: string; arch: Arch; available: boolean; run: (root: string) => void }

/**
 * Toolchains for A027: the local compiler; on an arm64 Mac also its x86-64
 * target; and GCC 12 (the runtime's toolchain) for linux/arm64 and
 * linux/amd64 when docker is present. `run` compiles every variant directory
 * under `root` (each holds its .cpp files, generated.hpp, rt/ and maybe
 * pre.h) into <cpp>.g.dis, <cpp>.plain.dis.
 */
const SHAPE_TOOLCHAINS: ShapeToolchain[] = (() => {
  const target = hasGpp ? execFileSync("g++", ["-dumpmachine"], { encoding: "utf8" }).trim() : "";
  const hostArch: Arch | undefined = /^(aarch64|arm64)/.test(target) ? "arm64" : /^x86_64/.test(target) ? "x86_64" : undefined;
  const cxx = RUNTIME_FLAGS.join(" ");
  const variantScript = (objdump: string): string => [
    "for d in /w/*/; do",
    '  pre=""; [ -f "$d/pre.h" ] && pre="-include $d/pre.h"',
    '  for f in "$d"/*.cpp; do',
    `    g++ ${cxx} -I"$d/rt" -I"$d" $pre -g -c "$f" -o "$f.g.o"`,
    `    ${objdump} -d -r -l --no-show-raw-insn "$f.g.o" > "$f.g.dis"`,
    `    g++ ${cxx} -I"$d/rt" -I"$d" $pre -c "$f" -o "$f.o"`,
    `    ${objdump} -d --no-show-raw-insn "$f.o" > "$f.plain.dis"`,
    "  done",
    "done",
  ].join("\n");
  const local = (extra: string[]) => (root: string): void => {
    for (const v of fs.readdirSync(root)) {
      const d = path.join(root, v);
      const pre = fs.existsSync(path.join(d, "pre.h")) ? ["-include", path.join(d, "pre.h")] : [];
      for (const cpp of fs.readdirSync(d).filter((f) => f.endsWith(".cpp")).map((f) => path.join(d, f))) {
        for (const [suffix, g] of [["g", ["-g"]], ["plain", []]] as const) {
          const c = gxx([...RUNTIME_FLAGS, ...extra, ...g, `-I${d}/rt`, `-I${d}`, ...pre, "-c", cpp, "-o", `${cpp}.${suffix}.o`]);
          expect(c.out, `g++ -c ${path.basename(cpp)}`).toBe(c.ok ? c.out : "<compiled>");
          const dis = execFileSync("objdump", ["-d", ...(g.length ? ["-r", "-l"] : []), "--no-show-raw-insn", `${cpp}.${suffix}.o`], {
            encoding: "utf8", maxBuffer: 64 << 20,
          });
          fs.writeFileSync(`${cpp}.${suffix}.dis`, dis);
        }
      }
    }
  };
  return [
    { label: `local ${target || "g++ (none)"}`, arch: hostArch ?? "arm64", available: !!hostArch, run: local([]) },
    {
      label: "local x86_64-apple-darwin (-arch x86_64)",
      arch: "x86_64",
      available: process.platform === "darwin" && hostArch === "arm64",
      run: local(["-arch", "x86_64"]),
    },
    ...(["linux/arm64", "linux/amd64"] as const).map((platform): ShapeToolchain => ({
      label: `GCC 12 ${platform}`,
      arch: platform === "linux/arm64" ? "arm64" : "x86_64",
      available: hasDocker,
      run: (root) => inGcc12(platform, root, variantScript("objdump")),
    })),
  ];
})();

describe.skipIf(!PROBES_ON)(`A027: every planted poll accounted for in the object code (${PROBE_CONFIG})`, () => {
  // One green build and three seeded defects, compiled together per toolchain.
  const VARIANTS: Array<{
    name: string;
    runtime?: [from: string, to: string];
    patch?: (code: string) => string;
    expectFailure?: RegExp;
    expectUnreachable?: RegExp;
  }> = [
    { name: "green" },
    {
      // A poll made an out-of-line call: no load remains, every site is
      // reachable and the call is a slow path on the idle path.
      name: "call",
      runtime: [
        "#define STRUCPP_DBG_ACTIVE_NOW() (*static_cast<volatile uint8_t*>(&strucpp_dbg_active) & STRUCPP_DBG_ACTIVE)",
        'extern "C" uint8_t strucpp_dbg_test_poll(void);\n#define STRUCPP_DBG_ACTIVE_NOW() (strucpp_dbg_test_poll() + (0 & strucpp_dbg_active))',
      ],
      expectFailure: /reachable .* but has no active load[\s\S]*slow-path call|slow-path call[\s\S]*reachable .* but has no active load/,
    },
    {
      // The two-load form: two byte loads combined before the branch.
      name: "two-load",
      runtime: [
        "#define STRUCPP_DBG_ACTIVE_NOW() (*static_cast<volatile uint8_t*>(&strucpp_dbg_active) & STRUCPP_DBG_ACTIVE)",
        "#define STRUCPP_DBG_ACTIVE_NOW() ((*static_cast<volatile uint8_t*>(&strucpp_dbg_active) | *static_cast<volatile uint8_t*>(&strucpp_dbg_active)) & STRUCPP_DBG_ACTIVE)",
      ],
      expectFailure: /loaded byte used by|not testb\+jcc/,
    },
    {
      // A site the codegen planted that silently compiles to nothing: SUMTO's
      // FOR back-edge poll (live: the loop runs) is guarded off.
      name: "missing",
      patch: (code) => code.replace(/^(\s*)(STRUCPP_POLL\(1, SUMTO__dbg_probed)/m, "$1if (0) $2"),
      expectFailure: /pou_SUMTO\.cpp:\d+ poll 1: reachable .* but has no active load/,
    },
    {
      // The valid absence: the same site made dead code in both builds (the
      // guard sits on the line before, so the reachability call is dead too).
      name: "dead",
      patch: (code) => code.replace(/^(\s*ACC = ACC \+ CLAMP\(.*;)$/m, "$1 if (0)"),
      expectUnreachable: /pou_SUMTO\.cpp:\d+ poll 1: absent, unreachable/,
    },
  ];

  for (const tc of SHAPE_TOOLCHAINS) {
    describe.skipIf(!tc.available)(tc.label, () => {
      const audits = new Map<string, PollAudit>();
      beforeAll(() => {
        const r = build(SHAPES);
        const root = path.join(tmpRoot, `a027-${tc.label.replace(/\W+/g, "-")}`);
        for (const v of VARIANTS) {
          for (const kind of ["main", "reach"] as const) {
            const dir = path.join(root, `${v.name}-${kind}`);
            fs.mkdirSync(dir, { recursive: true });
            fs.cpSync(RUNTIME_INCLUDE_PATH, path.join(dir, "rt"), { recursive: true });
            if (v.runtime) {
              const p = path.join(dir, "rt", "debug_probe.hpp");
              const text = fs.readFileSync(p, "utf8");
              expect(text.includes(v.runtime[0]), `${v.name}: debug_probe.hpp still has the text the seed replaces`).toBe(true);
              fs.writeFileSync(p, text.split(v.runtime[0]).join(v.runtime[1]));
            }
            fs.writeFileSync(path.join(dir, "generated.hpp"), r.headerCode);
            if (kind === "reach") fs.writeFileSync(path.join(dir, "pre.h"), REACH_DECL);
            for (const f of r.cppFiles) {
              const seeded = v.patch ? v.patch(f.content) : f.content;
              fs.writeFileSync(path.join(dir, f.name), kind === "reach" ? reachPatch(seeded) : seeded);
            }
          }
        }
        for (const v of VARIANTS.filter((x) => x.patch)) {
          if (v.patch!(cppOf(r)) === cppOf(r)) throw new Error(`the ${v.name} seed no longer matches the generated code`);
        }
        tc.run(root);
        for (const v of VARIANTS) {
          const dis = new Map<string, { g: string; plain: string; reach: string }>();
          for (const f of r.cppFiles) {
            const main = path.join(root, `${v.name}-main`, f.name);
            dis.set(f.name, {
              g: fs.readFileSync(`${main}.g.dis`, "utf8"),
              plain: fs.readFileSync(`${main}.plain.dis`, "utf8"),
              reach: fs.readFileSync(path.join(root, `${v.name}-reach`, `${f.name}.g.dis`), "utf8"),
            });
          }
          // Planted sites are those of the generated code, before any seed.
          audits.set(v.name, auditPolls(tc.arch, r.cppFiles, dis));
        }
      }, 900000);

      it("green: every planted poll is found in the exact shape or proven unreachable", () => {
        const a = audits.get("green")!;
        console.log(`A027 ${tc.label}:\n  ${a.report.join("\n  ")}`);
        expect(a.planted).toBeGreaterThan(10);
        expect(a.failures).toEqual([]);
      });

      for (const v of VARIANTS.filter((x) => x.expectUnreachable)) {
        it(`${v.name}: a site the compiler removed as dead code is accounted for as unreachable, not failed`, () => {
          const a = audits.get(v.name)!;
          expect(a.failures).toEqual([]);
          expect(a.report.join("\n")).toMatch(v.expectUnreachable!);
          expect(a.report[0]).toMatch(/ 1 unreachable, 0 missing$/);
        });
      }

      for (const v of VARIANTS.filter((x) => x.expectFailure)) {
        it(`red: ${v.name} seed fails the audit`, () => {
          const a = audits.get(v.name)!;
          console.log(`A027 ${tc.label} red ${v.name}: ${a.failures.length} failures, first: ${a.failures[0]}`);
          expect(a.failures.join("\n")).toMatch(v.expectFailure!);
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// A″ frame: on the runtime's toolchain (GCC 12, arm64, Makefile.strucpp flags),
// every function frameless in the probe-off build stays frameless on the
// probe-on idle path.
// ---------------------------------------------------------------------------


/** Compile every .cpp under `root` in the GCC 12 image; returns objdump -dr per object. */
function gcc12Disassemble(root: string, include: string): Map<string, string> {
  const cxx = [...RUNTIME_FLAGS.filter((f) => f !== "-fno-gnu-unique"), "-fno-gnu-unique"].join(" ");
  const script = [
    "set -e",
    "cd /w",
    `find . -name '*.cpp' | xargs -P2 -I{} sh -c 'g++ ${cxx} -I/rt -I"$(dirname {})" -c {} -o {}.o && objdump -dr --no-show-raw-insn {}.o > {}.dis'`,
  ].join("\n");
  const res = spawnSync("docker", [
    "run", "--rm", "--platform", "linux/arm64", "--cpus", "2",
    "-v", `${root}:/w`, "-v", `${include}:/rt:ro`, ensureGcc12("linux/arm64"), "sh", "-c", script,
  ], { encoding: "utf8", maxBuffer: 64 << 20, timeout: 900000 });
  expect(`${res.stdout}${res.stderr}`, "gcc 12 build").toBe(res.status === 0 ? `${res.stdout}${res.stderr}` : "<built>");
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".dis")) out.set(path.relative(root, p), fs.readFileSync(p, "utf8"));
    }
  };
  walk(root);
  return out;
}

interface FrameReport {
  /** Function (mangled) -> the frame instructions on its idle path; [] = frameless. */
  frames: Map<string, string[]>;
}

/**
 * Frame instructions an aarch64 function executes on its idle path: control
 * flow from entry, not following the active branch of a poll (the branch after
 * a load of strucpp_dbg_active). A frame is an sp adjustment or a spill of
 * x19-x30 / d8-d15 to the stack. An indirect `br` is taken to reach every
 * instruction, so it can only over-report.
 */
function idleFrames(dis: string): FrameReport {
  type Insn = { addr: number; mn: string; ops: string; relocs: string[] };
  const funcs = new Map<string, Insn[]>();
  let fn = "";
  for (const raw of dis.split("\n")) {
    const head = /^[0-9a-f]+ <(.+)>:$/.exec(raw.trim());
    if (head) {
      fn = head[1]!;
      funcs.set(fn, []);
      continue;
    }
    if (!fn) continue;
    const list = funcs.get(fn)!;
    const reloc = /^\s*[0-9a-f]+:\s+R_\S+\s+(\S+)/.exec(raw);
    if (reloc) {
      list[list.length - 1]?.relocs.push(reloc[1]!);
      continue;
    }
    const m = /^\s*([0-9a-f]+):\s+(\S+)\s*(.*)$/.exec(raw);
    if (m) list.push({ addr: parseInt(m[1]!, 16), mn: m[2]!, ops: m[3]!.trim(), relocs: [] });
  }
  const frames = new Map<string, string[]>();
  for (const [name, insns] of funcs) {
    const at = new Map(insns.map((ins, i) => [ins.addr, i]));
    const target = (ops: string): number | undefined => {
      const t = /\b([0-9a-f]+) <[^>]*>$/.exec(ops);
      return t ? at.get(parseInt(t[1]!, 16)) : undefined;
    };
    // Registers holding &strucpp_dbg_active (adrp + add hoisted out of a loop),
    // trusted only when nothing else in the function writes them, the
    // transfer block's register restore (ldp from its sp save area) aside.
    const dests = (ins: Insn): string[] => {
      const regs = /^([xw]\d+), (?:([xw]\d+), )?/.exec(ins.ops);
      if (!regs || /^(st|cmp|tst|cb|tb)/.test(ins.mn)) return [];
      return (ins.mn === "ldp" ? [regs[1], regs[2]] : [regs[1]])
        .filter((r): r is string => !!r)
        .map((r) => r.replace(/^w/, "x"));
    };
    const isActive = (ins: Insn): boolean => ins.relocs.some((r) => r.includes("strucpp_dbg_active"));
    const addrRegs = new Set(
      insns
        .filter((ins) => ins.mn === "add" && isActive(ins))
        .flatMap(dests)
        .filter((reg) => insns.every((o) =>
          !dests(o).includes(reg) || isActive(o) || (o.mn === "ldp" && o.ops.includes("[sp, #")))),
    );
    const activeLoad = (ins: Insn): boolean =>
      /^ldr/.test(ins.mn) &&
      (isActive(ins) ||
        [...addrRegs].some((reg) => ins.ops.endsWith(`[${reg}]`)));
    // Poll branches: the first branch within two instructions of an active-byte load.
    const pollTaken = new Set<number>();
    insns.forEach((ins, i) => {
      if (!activeLoad(ins)) return;
      for (let j = i + 1; j <= i + 2 && j < insns.length; j++) {
        if (/^(tbnz|tbz|cbnz|cbz|b\.)/.test(insns[j]!.mn)) {
          pollTaken.add(j);
          break;
        }
      }
    });
    const seen = new Set<number>();
    const work = [0];
    while (work.length) {
      const i = work.pop()!;
      if (i >= insns.length || seen.has(i)) continue;
      seen.add(i);
      const { mn, ops } = insns[i]!;
      if (mn === "ret") continue;
      if (mn === "br") {
        insns.forEach((_, k) => work.push(k));
        continue;
      }
      if (mn === "b") {
        const t = target(ops);
        if (t !== undefined) work.push(t);
        continue;
      }
      if (/^(tbnz|tbz|cbnz|cbz|b\.)/.test(mn)) {
        // A poll's idle direction is "bit clear / zero": tbnz/cbnz/b.ne fall through.
        if (pollTaken.has(i)) {
          if (/^(tbnz|cbnz|b\.ne)$/.test(mn)) work.push(i + 1);
          else work.push(target(ops) ?? i + 1);
          continue;
        }
        const t = target(ops);
        if (t !== undefined) work.push(t);
      }
      work.push(i + 1);
    }
    const hits: string[] = [];
    for (const i of seen) {
      const { mn, ops } = insns[i]!;
      const spAdjust = /\[sp, #-\d+\]!/.test(ops) || (mn === "sub" && /^sp, sp\b/.test(ops));
      const spill = /^(stp|str)$/.test(mn) && ops.includes("[sp") &&
        /\b(x(19|2\d|30)|d(8|9|1[0-5]))\b/.test(ops.split("[")[0]!);
      if (spAdjust || spill) hits.push(`${mn} ${ops}`);
    }
    frames.set(name, hits);
  }
  return { frames };
}

describe.skipIf(!hasDocker || !PROBES_ON)(`A″ frame: frameless probe-off functions stay frameless probe-on (GCC 12 arm64) (${PROBE_CONFIG})`, () => {
  function frames(variant: string, corpus: Array<[string, string]>, opts: Partial<CompileOptions>, include = RUNTIME_INCLUDE_PATH): Map<string, string[]> {
    const root = path.join(tmpRoot, `frames-${variant}`);
    corpus.forEach(([name, src], n) => {
      const r = compile(src, { headerFileName: "generated.hpp", libraries: [IEC_STDLIB], ...opts });
      if (!r.success) return;
      const dir = path.join(root, `p${n}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "generated.hpp"), r.headerCode);
      fs.writeFileSync(path.join(dir, "NAME"), name);
      for (const f of r.cppFiles) fs.writeFileSync(path.join(dir, f.name), f.content);
    });
    const all = new Map<string, string[]>();
    for (const [obj, dis] of gcc12Disassemble(root, include)) {
      const prog = fs.readFileSync(path.join(root, path.dirname(obj), "NAME"), "utf8");
      for (const [fn, hits] of idleFrames(dis).frames) all.set(`${prog} ${fn}`, hits);
    }
    return all;
  }

  /** Functions frameless OFF that have an idle-path frame ON, and the frameless counts. */
  function regressions(off: Map<string, string[]>, on: Map<string, string[]>): { offFrameless: number; onFrameless: number; lost: string[] } {
    let offFrameless = 0;
    let onFrameless = 0;
    const lost: string[] = [];
    for (const [fn, hits] of off) {
      if (hits.length) continue;
      offFrameless++;
      const h = on.get(fn);
      expect(h, `${fn} missing from the probe-on build`).toBeDefined();
      if (h!.length === 0) onFrameless++;
      else lost.push(`${fn}: ${h!.join(" ; ")}`);
    }
    return { offFrameless, onFrameless, lost };
  }

  beforeAll(() => {
    ensureGcc12("linux/arm64");
  }, 900000);

  it("every corpus function frameless in probe-off is frameless on the probe-on idle path", () => {
    const corpus: Array<[string, string]> = [["inline:shapes", SHAPES], ...validationSources()];
    const off = frames("off", corpus, { debugProbes: false });
    const on = frames("on", corpus, {});
    const r = regressions(off, on);
    console.log(`frameless: OFF ${r.offFrameless}, ON ${r.onFrameless}`);
    expect(r.offFrameless).toBeGreaterThan(20);
    expect(r.lost).toEqual([]);
  }, 900000);

  it("red: with the transfer as a plain `return` of the probed clone, frameless functions gain a frame", () => {
    const corpus: Array<[string, string]> = [["inline:shapes", SHAPES]];
    const rt = patchedRuntime("xfer-return", "debug_probe.hpp",
      "#if defined(__aarch64__) && defined(__GNUC__)\n#define STRUCPP_POLL_X", "#if 0\n#define STRUCPP_POLL_X");
    const r = regressions(frames("red-off", corpus, { debugProbes: false }), frames("red-on", corpus, {}, rt));
    expect(r.lost.map((l) => l.split(": ")[0])).toEqual(expect.arrayContaining([
      "inline:shapes _ZN7strucpp5CLAMPENS_6IECVarIiEES1_S1_",
      "inline:shapes _ZN7strucpp7COUNTER4BUMPENS_6IECVarIiEE",
    ]));
  }, 900000);
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

      // Positive control for the marker pattern, explicit so it holds in either configuration.
      const on = build(src, { debugProbes: true });
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
    // handle_set answers STATUS_OK (0x7E).
    expect(res.out).toContain("probes=0 count=5 in1=7 out1=99 set=126");
  });

  it.skipIf(PROBES_ON)(`probe-off configuration: a build that names no probe setting is the probe-off build (${PROBE_CONFIG})`, () => {
    for (const src of [PLANT, SHAPES]) {
      const def = build(src);
      const off = build(src, { debugProbes: false });
      expect(cppOf(def)).toBe(cppOf(off));
      expect(def.headerCode).toBe(off.headerCode);
      expect(`${def.headerCode}\n${cppOf(def)}`).not.toMatch(PROBE_MARKERS);
    }
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

describe.skipIf(!hasGpp || !PROBES_ON)(`transfer: arming mid-loop continues in the probed clone with the same locals (${PROBE_CONFIG})`, () => {
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

  // c7052da's register-saving asm handoff (STRUCPP_POLL_X) is aarch64-only;
  // every other target, x86-64 included, keeps the previous C++ form (the
  // poll returns a call of the probed clone). Both CI platforms, on the
  // runtime's GCC 12: every scenario continues at the poll site, and the
  // object code shows which form each one compiled.
  for (const platform of ["linux/arm64", "linux/amd64"] as const) {
    const asm = platform === "linux/arm64";
    it.skipIf(!hasDocker)(`GCC 12 ${platform}: every scenario continues at the poll site, ${asm ? "through the asm handoff" : "through the C++ tail-return fallback"}`, () => {
      const r = build(TRANSFER);
      const { dir, cpps } = writeTree(`xfer-gcc12-${platform.replace("/", "-")}`, r);
      fs.writeFileSync(path.join(dir, "main.cpp"), TRANSFER_MAIN);
      fs.cpSync(RUNTIME_INCLUDE_PATH, path.join(dir, "rt"), { recursive: true });
      fs.cpSync(TEST_RUNTIME_PATH, path.join(dir, "rtt"), { recursive: true });
      const runs = SCENARIOS.map((sc) => `./a.out ${sc.id} ${probeAt(TRANSFER, r, sc.marker)} ${sc.armAt} >> out.txt`);
      inGcc12(platform, dir, [
        "cd /w",
        ...["main.cpp", ...cpps.map((c) => path.basename(c))].map(
          (f) => `g++ ${RUNTIME_FLAGS.join(" ")} -Irt -Irtt -I. -c ${f} -o ${f}.o`),
        "g++ -pthread *.o -o a.out",
        "objdump -dr --no-show-raw-insn *.cpp.o > all.dis",
        ": > out.txt",
        ...runs,
      ].join("\n"));
      expect(fs.readFileSync(path.join(dir, "out.txt"), "utf8").trim().split("\n")).toEqual(SCENARIOS.map((sc) => sc.expect));
      // The asm block reaches the transfer stub by address (a relocation
      // against __dbg_xfer); the C++ form never names the stub.
      const xferRefs = (fs.readFileSync(path.join(dir, "all.dis"), "utf8").match(/^\s+[0-9a-f]+: R_\S+\s+\S*__dbg_xfer/gm) ?? []).length;
      if (asm) expect(xferRefs).toBeGreaterThan(0);
      else expect(xferRefs).toBe(0);
    }, 900000);
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

describe.skipIf(!hasGpp || !PROBES_ON)(`probed clones: validation programs pass with a session attached from the start (${PROBE_CONFIG})`, () => {
  // Loops, properties (getter/setter clones) and SUPER calls into a base
  // body; functions with locals are covered by the transfer tests above.
  const PAIRS = [
    "control_flow/nested_loops",
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
  for (int t = 0; t < 200 && !done; ++t) std::this_thread::sleep_for(std::chrono::milliseconds(5));
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
    expect(code).toMatch(/auto (__gcs_\d+) = UNITS\.at\(F\(I\)\)\.Q;\s*\n\s*G_ARR->with_lock\(\[&\]\(auto\* __glk\)\{ \(\*__glk\)\.at\(1\) = \1; \}\);/);
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

  describe.skipIf(!hasGpp || !PROBES_ON)(`two tasks against the stub host (STRUCPP_THREADED) (${PROBE_CONFIG})`, () => {
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
