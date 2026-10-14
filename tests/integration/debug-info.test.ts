/**
 * debug-info.json: every corpus build validates against the
 * published schema, every declared variable is described in its scope with
 * its IEC type, rich types carry their bounds, lengths and targets, and the
 * statement map agrees with every corpus oracle and marker.
 *
 * See also:
 *   src/backend/debug-info-gen.ts - the emitter under test.
 *   docs/debug-info.schema.json - the published JSON Schema.
 *   docs/DEBUG_INFO.md - the prose every schema property must appear in.
 */

import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import {
  serializeDebugInfo,
  type DebugInfoV1,
} from "../../src/backend/debug-info-gen.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";
import type { LineMapEntry } from "../../src/types.js";

const ROOT = path.resolve(__dirname, "../..");
const SCHEMA_PATH = path.join(ROOT, "docs/debug-info.schema.json");
const PROSE_PATH = path.join(ROOT, "docs/DEBUG_INFO.md");
const LIBS_DIR = path.join(ROOT, "libs");

// The corpus lives in openplc-runtime. Naming it explicitly makes its absence
// a failure; the default sibling-checkout path skips with a reason instead.
const CORPUS_ENV = process.env["STRUCPP_DEBUG_CORPUS"];
const CORPUS_DIR =
  CORPUS_ENV ?? path.resolve(ROOT, "../openplc-runtime/tests/debug/corpus");
const corpusPresent = fs.existsSync(CORPUS_DIR);
if (!corpusPresent && CORPUS_ENV === undefined) {
  console.warn(
    `debug-info corpus sweep skipped: no corpus at ${CORPUS_DIR} (set STRUCPP_DEBUG_CORPUS)`,
  );
}

/** Corpus programs STruCpp cannot compile yet, with the reason. */
const EXPECTED_FAIL: Record<string, string> = {
  "generated-region": "the {strucpp generated} pragmas are not lexed yet",
  "iec-display": "a variable named `by` is lexed as the BY keyword",
  "multi-task":
    "codegen refuses a shared function-block global called from a program",
  "retain-vars": "a PROGRAM named `Retain` is lexed as the RETAIN keyword",
  "rich-types": "UNION types are not parsed",
};

const schema: unknown = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema as object);

function schemaErrors(json: string): string[] {
  if (validate(JSON.parse(json))) return [];
  return (validate.errors ?? []).map((e) => `${e.dataPath} ${e.message}`);
}

const stdLibs = discoverStlibs(LIBS_DIR);

function headerValue(source: string, key: string): string | undefined {
  const header = source.slice(0, source.indexOf("*)"));
  const m = new RegExp(`^\\s*${key}:\\s*(.+)$`, "m").exec(header);
  return m?.[1]?.trim();
}

function corpusLibraries(dir: string, name: string): StlibArchive[] {
  const libDir = path.join(dir, "lib");
  if (!fs.existsSync(libDir)) return stdLibs;
  const sources = fs
    .readdirSync(libDir)
    .filter((f) => f.endsWith(".st"))
    .map((f) => ({
      fileName: f,
      source: fs.readFileSync(path.join(libDir, f), "utf8"),
    }));
  const lib = compileStlib(sources, {
    name: `${name}-lib`,
    version: "1.0.0",
    namespace: `${name.replace(/-/g, "_")}_lib`,
    noSource: true,
    dependencies: stdLibs,
  });
  if (!lib.success) {
    throw new Error(`${name}/lib failed: ${JSON.stringify(lib.errors)}`);
  }
  return [...stdLibs, lib.archive];
}

interface CorpusBuild {
  label: string;
  ok: boolean;
  info?: DebugInfoV1;
  error?: string;
  sources: Array<{ fileName: string; source: string }>;
  lineMap?: Map<number, LineMapEntry>;
  warnings?: string[];
}

const buildCache = new Map<string, CorpusBuild[]>();

/** Every build a corpus program defines: the main build and each variant. */
function corpusBuilds(name: string): CorpusBuild[] {
  const cached = buildCache.get(name);
  if (cached) return cached;
  const builds = buildCorpus(name);
  buildCache.set(name, builds);
  return builds;
}

function buildCorpus(name: string): CorpusBuild[] {
  const dir = path.join(CORPUS_DIR, name);
  const main = fs.readFileSync(path.join(dir, "program.st"), "utf8");
  const files = (headerValue(main, "sources") ?? "program.st").split(/\s+/);
  const libraries = corpusLibraries(dir, name);
  const builds: Array<{ label: string; files: string[] }> = [
    { label: name, files },
    ...fs
      .readdirSync(dir)
      .filter((f) => /^variant-.*\.st$/.test(f))
      .map((f) => ({ label: `${name}/${f}`, files: [f] })),
  ];
  return builds.map(({ label, files: buildFiles }) => {
    const sources = buildFiles.map((f) => ({
      fileName: f,
      source: fs.readFileSync(path.join(dir, f), "utf8"),
    }));
    const [first, ...rest] = sources;
    try {
      const r = compile(first!.source, {
        fileName: first!.fileName,
        additionalSources: rest,
        libraries,
      });
      if (!r.success) {
        return {
          label,
          ok: false,
          sources,
          error: r.errors[0]?.message ?? "failed",
        };
      }
      return {
        label,
        ok: true,
        sources,
        lineMap: r.lineMap,
        warnings: r.warnings.map((w) => w.message),
        ...(r.debugInfo ? { info: r.debugInfo } : {}),
      };
    } catch (e) {
      return { label, ok: false, sources, error: String(e) };
    }
  });
}

const corpusNames = corpusPresent
  ? fs
      .readdirSync(CORPUS_DIR)
      .filter((d) => fs.existsSync(path.join(CORPUS_DIR, d, "program.st")))
      .sort()
  : [];

describe.skipIf(!corpusPresent && CORPUS_ENV === undefined)(
  "debug-info.json: corpus builds validate against the schema (A030)",
  () => {
    it("finds the corpus", () => {
      expect(corpusPresent, `no corpus at ${CORPUS_DIR}`).toBe(true);
      expect(corpusNames.length).toBeGreaterThan(0);
    });

    it.each(corpusNames)("%s", (name) => {
      const builds = corpusBuilds(name);
      const reason = EXPECTED_FAIL[name];
      if (reason !== undefined) {
        expect(
          builds[0]!.ok,
          `${name} compiles now; remove it from EXPECTED_FAIL (${reason})`,
        ).toBe(false);
        return;
      }
      for (const b of builds) {
        expect(b.error, b.label).toBeUndefined();
        expect(b.info, `${b.label}: no debugInfo`).toBeDefined();
        expect(schemaErrors(serializeDebugInfo(b.info!)), b.label).toEqual([]);
      }
    });

    it("refuses a debug-info whose field has the wrong type (red-proof)", () => {
      const [b] = corpusBuilds("all-scopes-types");
      const json = JSON.parse(serializeDebugInfo(b!.info!)) as {
        types: Array<{ id: unknown }>;
      };
      json.types[0]!.id = "0";
      expect(schemaErrors(JSON.stringify(json))).not.toEqual([]);
    });

    it("keeps the largest corpus program's debug-info under 1.5 MB (A021)", () => {
      const [b] = corpusBuilds("large-50k");
      expect(b!.info, "large-50k: no debugInfo").toBeDefined();
      const bytes = new TextEncoder().encode(serializeDebugInfo(b!.info!));
      console.info(`large-50k debug-info.json: ${bytes.length} bytes`);
      expect(bytes.length).toBeLessThan(1_500_000);
    });
  },
);

describe("debug-info schema publication (N008)", () => {
  it("describes every schema property in docs/DEBUG_INFO.md", () => {
    const prose = fs.readFileSync(PROSE_PATH, "utf8");
    const names = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      const props = obj["properties"];
      if (props && typeof props === "object") {
        for (const k of Object.keys(props)) names.add(k);
      }
      Object.values(obj).forEach(walk);
    };
    walk(schema);
    const missing = [...names].filter((n) => !prose.includes(`\`${n}\``));
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Read-back views over a DebugInfoV1, written independently of the emitter.
// ---------------------------------------------------------------------------

function typeLabel(info: DebugInfoV1, id: number): string {
  const t = info.types.find((x) => x.id === id);
  if (!t) return `<missing type ${id}>`;
  switch (t.kind) {
    case "array": {
      const dims = (t.dims ?? [])
        .map((d) => (d === null ? "*" : `${d[0]}..${d[1]}`))
        .join(", ");
      return `ARRAY[${dims}] OF ${typeLabel(info, t.elem!)}`;
    }
    case "string":
      return `${t.wide ? "WSTRING" : "STRING"}(${t.length})`;
    case "ref":
      return `REF_TO ${t.target === null ? "?" : typeLabel(info, t.target!)}`;
    default:
      return t.name ?? `<anonymous ${t.kind}>`;
  }
}

/** Section → variable → type label, for one POU, from locals, members and externals. */
function scopesOf(
  info: DebugInfoV1,
  pouName: string,
): Record<string, Record<string, string>> {
  const pou = info.pous.find((p) => p.name === pouName);
  if (!pou) throw new Error(`no POU ${pouName}`);
  const out: Record<string, Record<string, string>> = {};
  const put = (section: string, name: string, typeId: number): void => {
    (out[section] ??= {})[name] = typeLabel(info, typeId);
  };
  for (const l of pou.locals) put(l.kind, l.name, l.typeId);
  if (pou.typeId !== null) {
    const t = info.types.find((x) => x.id === pou.typeId)!;
    for (const m of t.members ?? []) put(m.section ?? "?", m.name, m.typeId);
  }
  for (const e of info.externals.filter((x) => x.pou === pou.id)) {
    const g = e.global === null ? undefined : info.globals[e.global];
    put("VAR_EXTERNAL", e.name, g ? g.typeId : -1);
  }
  return out;
}

const CONFIG = (programType: string): string => `
CONFIGURATION Config0
  VAR_GLOBAL
    G_COUNT : DINT;
    G_SEG : Seg;
  END_VAR
  RESOURCE Res0 ON PLC
    TASK Main(INTERVAL := T#100ms, PRIORITY := 1);
    PROGRAM PROG0 WITH Main : ${programType};
  END_RESOURCE
END_CONFIGURATION`;

// Mirrors openplc-runtime tests/debug/corpus/all-scopes-types/program.st.
const ALL_SCOPES = `
TYPE
  Mode : (IDLE, RUN, FAULT);
  Point : STRUCT x : INT; y : INT; END_STRUCT;
  Seg : STRUCT a : Point; b : Point; tag : Mode; END_STRUCT;
END_TYPE
FUNCTION Scale : INT
  VAR_INPUT v : INT; END_VAR
  VAR_IN_OUT acc : INT; END_VAR
  VAR_TEMP t : INT; END_VAR
  t := v * 2; acc := acc + t; Scale := t;
END_FUNCTION
FUNCTION_BLOCK Holder
  VAR_INPUT in1 : INT; END_VAR
  VAR_OUTPUT out1 : INT; END_VAR
  VAR_IN_OUT io : INT; END_VAR
  VAR_EXTERNAL G_COUNT : DINT; G_SEG : Seg; END_VAR
  VAR state : Mode := IDLE; END_VAR
  VAR_TEMP tmp : INT; END_VAR
  tmp := in1 + 1; io := io + tmp; out1 := tmp; G_COUNT := G_COUNT + 1; state := RUN;
END_FUNCTION_BLOCK
PROGRAM Scopes
  VAR
    witness AT %QD0 : DINT;
    in_v AT %IW0 : INT;
    out_v AT %QW0 : INT;
    h : Holder;
    shared : INT;
    arr : ARRAY[1..4] OF INT;
    segs : ARRAY[0..1] OF Seg;
    grid : ARRAY[0..2] OF Point;
    m : Mode;
    i : INT;
  END_VAR
  VAR_EXTERNAL G_COUNT : DINT; G_SEG : Seg; END_VAR
  witness := witness + 1;
  h(in1 := in_v, io := shared);
  out_v := Scale(h.out1, shared);
END_PROGRAM
${CONFIG("Scopes")}`;

function lazy<T>(f: () => T): () => T {
  let v: T | undefined;
  return () => (v ??= f());
}

function debugInfoOf(source: string): {
  info: DebugInfoV1;
  leafPaths: string[];
} {
  const r = compile(source, { fileName: "program.st" });
  expect(r.errors).toEqual([]);
  expect(r.debugInfo).toBeDefined();
  return {
    info: r.debugInfo!,
    leafPaths: r.debugMap!.leaves.map((l) => l.path),
  };
}

describe("debug-info.json: variables of every scope with IEC types (A013)", () => {
  const built = lazy(() => debugInfoOf(ALL_SCOPES));

  it("lists exactly the declared variables of each POU, by scope, with their types", () => {
    const { info } = built();
    expect(scopesOf(info, "SCALE")).toEqual({
      VAR_INPUT: { V: "INT" },
      VAR_IN_OUT: { ACC: "INT" },
      VAR_TEMP: { T: "INT" },
    });
    expect(scopesOf(info, "HOLDER")).toEqual({
      VAR_INPUT: { IN1: "INT" },
      VAR_OUTPUT: { OUT1: "INT" },
      VAR_IN_OUT: { IO: "INT" },
      VAR_EXTERNAL: { G_COUNT: "DINT", G_SEG: "SEG" },
      VAR: { STATE: "MODE" },
      VAR_TEMP: { TMP: "INT" },
    });
    expect(scopesOf(info, "SCOPES")).toEqual({
      VAR: {
        WITNESS: "DINT",
        IN_V: "INT",
        OUT_V: "INT",
        H: "HOLDER",
        SHARED: "INT",
        ARR: "ARRAY[1..4] OF INT",
        SEGS: "ARRAY[0..1] OF SEG",
        GRID: "ARRAY[0..2] OF POINT",
        M: "MODE",
        I: "INT",
      },
      VAR_EXTERNAL: { G_COUNT: "DINT", G_SEG: "SEG" },
    });
    expect(
      Object.fromEntries(
        info.globals.map((g) => [g.name, typeLabel(info, g.typeId)]),
      ),
    ).toEqual({ G_COUNT: "DINT", G_SEG: "SEG" });
  });

  it("describes nested struct layout, enum members and located variables", () => {
    const { info } = built();
    const byName = (n: string) => info.types.find((t) => t.name === n)!;
    const members = (n: string) =>
      byName(n).members!.map((m) => [m.name, typeLabel(info, m.typeId)]);
    expect(members("SEG")).toEqual([
      ["A", "POINT"],
      ["B", "POINT"],
      ["TAG", "MODE"],
    ]);
    expect(members("POINT")).toEqual([
      ["X", "INT"],
      ["Y", "INT"],
    ]);
    expect(byName("MODE")).toMatchObject({
      kind: "enum",
      values: [
        ["IDLE", 0],
        ["RUN", 1],
        ["FAULT", 2],
      ],
    });
    const scopes = byName("SCOPES").members!;
    expect(scopes.find((m) => m.name === "WITNESS")!.location).toBe("%QD0");
  });

  it("addresses instances and globals through debug-map leaves; externals resolve to their global", () => {
    const { info, leafPaths } = built();
    const inst = (p: string) => {
      const i = info.instances.path.indexOf(p);
      expect(i, p).toBeGreaterThanOrEqual(0);
      return {
        type: typeLabel(info, info.instances.typeId[i]!),
        leaf: leafPaths[info.instances.leafBase[i]!],
      };
    };
    expect(inst("PROG0")).toEqual({ type: "SCOPES", leaf: "PROG0.WITNESS" });
    expect(inst("PROG0.H")).toEqual({ type: "HOLDER", leaf: "PROG0.H.IN1" });

    const holder = info.pous.find((p) => p.name === "HOLDER")!;
    const ext = info.externals.find(
      (e) => e.pou === holder.id && e.name === "G_COUNT",
    )!;
    const g = info.globals[ext.global!]!;
    expect(g.name).toBe("G_COUNT");
    expect(leafPaths[g.leafBase!]).toBe("G_COUNT");
  });
});

describe("debug-info.json: rich types (A016)", () => {
  // openplc-runtime corpus:rich-types without its UNION, which STruCpp does not parse.
  const built = lazy(() =>
    debugInfoOf(`
TYPE
  Pct : INT (0..100);
  Point : STRUCT x : INT; y : INT; END_STRUCT;
  Seg : STRUCT a : Point; END_STRUCT;
END_TYPE
PROGRAM Rich
  VAR
    s : STRING(16) := 'hello';
    ws : WSTRING(8) := "wide";
    plain : STRING;
    m2 : ARRAY[0..1, 1..3] OF INT;
    p : Pct := 50;
    target : INT := 7;
    r : REF_TO INT;
  END_VAR
  r := REF(target);
END_PROGRAM
${CONFIG("Rich")}`),
  );

  const typeOf = (name: string) => {
    const { info } = built();
    const m = info.types
      .find((t) => t.name === "RICH")!
      .members!.find((x) => x.name === name)!;
    return info.types.find((t) => t.id === m.typeId)!;
  };

  it("gives strings their declared length and width", () => {
    expect(typeOf("S")).toMatchObject({
      kind: "string",
      length: 16,
      wide: false,
    });
    expect(typeOf("WS")).toMatchObject({
      kind: "string",
      length: 8,
      wide: true,
    });
    expect(typeOf("PLAIN")).toMatchObject({ kind: "string", length: 254 });
  });

  it("gives every array dimension its bounds", () => {
    expect(typeOf("M2")).toMatchObject({
      kind: "array",
      dims: [
        [0, 1],
        [1, 3],
      ],
    });
  });

  it("gives a subrange its name, base and bounds, and a REF_TO its target", () => {
    const { info } = built();
    const p = typeOf("P");
    expect(p).toMatchObject({ kind: "subrange", name: "PCT", range: [0, 100] });
    expect(typeLabel(info, p.base!)).toBe("INT");
    expect(typeLabel(info, typeOf("R").id)).toBe("REF_TO INT");
  });
});

// ---------------------------------------------------------------------------
// Statement map: probes, line lists and breakpoint placement.
// ---------------------------------------------------------------------------

interface ProbeRow {
  id: number;
  pou: number;
  file: number;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  kind: number;
}

function probesOf(info: DebugInfoV1): ProbeRow[] {
  const p = info.probes;
  return p.line.map((line, id) => ({
    id,
    pou: p.pou[id]!,
    file: p.file[id]!,
    line,
    col: p.col[id]!,
    endLine: p.endLine[id]!,
    endCol: p.endCol[id]!,
    kind: p.kind[id]!,
  }));
}

type Placement =
  | { verified: true; line: number; probe: ProbeRow }
  | { verified: false; reason: "NO_CODE" };

/**
 * Reference reader for ADR-002 D3 (F026): line L binds to the smallest
 * probe line >= L of the innermost POU whose span holds L, at its first
 * probe by column; with none, it is unverified NO_CODE.
 */
function placeBreakpoint(
  info: DebugInfoV1,
  file: number,
  line: number,
): Placement {
  const height = (s: [number, number, number, number]): number => s[2] - s[0];
  const pou = info.pous
    .filter((p) => p.file === file && p.span !== null)
    .filter((p) => p.span![0] <= line && line <= p.span![2])
    .sort((a, b) => height(a.span!) - height(b.span!))[0];
  const next = probesOf(info)
    .filter((p) => pou !== undefined && p.pou === pou.id && p.line >= line)
    .sort((a, b) => a.line - b.line || a.col - b.col || a.id - b.id)[0];
  return next === undefined
    ? { verified: false, reason: "NO_CODE" }
    : { verified: true, line: next.line, probe: next };
}

const MARKER = /\(\*@([A-Za-z0-9_-]+)\*\)/g;

function markersOf(source: string): Map<string, number> {
  const out = new Map<string, number>();
  source.split("\n").forEach((text, i) => {
    for (const m of text.matchAll(MARKER)) out.set(`@${m[1]}`, i + 1);
  });
  return out;
}

/** Words a probe may never start at: declarations and block ends. */
const NOT_A_STATEMENT =
  /^(VAR\w*|END_\w+|ELSE|THEN|DO|OF|TYPE|STRUCT|FUNCTION\w*|PROGRAM|METHOD|PROPERTY|GET|SET)\b/i;

/** Probe and placement invariants over every line of every file of one build. */
function lineInvariants(b: CorpusBuild): string[] {
  const info = b.info!;
  const bad: string[] = [];
  const probes = probesOf(info);
  for (const f of info.files) {
    const listed = new Set(info.lines[String(f.id)] ?? []);
    const text = b.sources.find((s) => s.fileName === f.path)!.source;
    const lines = text.split("\n");
    for (const p of probes.filter((x) => x.file === f.id)) {
      const at = (lines[p.line - 1] ?? "").slice(p.col - 1);
      if (!/^[A-Za-z_]/.test(at) || NOT_A_STATEMENT.test(at)) {
        bad.push(
          `${b.label} ${f.path}:${p.line}:${p.col} probe on "${at.trim().slice(0, 20)}"`,
        );
      }
      if (!listed.has(p.line))
        bad.push(`${b.label} probe ${p.id} line ${p.line} not listed`);
    }
    for (let line = 1; line <= lines.length; line++) {
      const r = placeBreakpoint(info, f.id, line);
      const where = `${b.label} ${f.path}:${line}`;
      if (listed.has(line) && !(r.verified && r.line === line)) {
        bad.push(`${where} listed but not verified there`);
      }
      if (!listed.has(line) && r.verified && r.line <= line) {
        bad.push(`${where} unlisted but verified at ${r.line}`);
      }
    }
  }
  if (info.files.length === 1 && b.lineMap) {
    for (const p of probes) {
      if (!(b.lineMap.get(p.line)?.probeIds ?? []).includes(p.id)) {
        bad.push(
          `${b.label} probe ${p.id} missing from lineMap line ${p.line}`,
        );
      }
    }
  }
  for (const w of b.warnings ?? []) {
    if (/probe/i.test(w)) bad.push(`${b.label} warning: ${w}`);
  }
  return bad;
}

interface OracleStep {
  inspect?: string;
  request?: string;
  event?: string;
  args?: { file?: string; lines?: unknown };
  expect?: {
    linesByFile?: Record<string, string[]>;
    body?: {
      breakpoints?: Array<{
        verified: boolean;
        line?: string;
        reason?: string;
      }>;
    };
    location?: {
      file?: unknown;
      line?: unknown;
      col?: number;
      endLine?: unknown;
    };
    stack?: Array<{ pou?: string; kind?: string; instance?: string | null }>;
  };
}

/** Checks one oracle's debug-info claims; returns the disagreements. */
function oracleDisagreements(
  corpus: string,
  oracleFile: string,
  builds: CorpusBuild[],
): string[] {
  const oracle = JSON.parse(
    fs.readFileSync(path.join(CORPUS_DIR, corpus, oracleFile), "utf8"),
  ) as { steps?: OracleStep[] };
  const bad: string[] = [];
  const tag = `${corpus}/${oracleFile}`;
  const buildOf = (file: string): CorpusBuild | undefined =>
    builds.find((b) => b.ok && b.sources.some((s) => s.fileName === file));
  const resolve = (b: CorpusBuild, file: string, marker: string) => {
    const src = b.sources.find((s) => s.fileName === file)!.source;
    const line = markersOf(src).get(marker);
    const fileId = b.info!.files.find((f) => f.path === file)!.id;
    return { line, fileId };
  };
  for (const step of oracle.steps ?? []) {
    const ex = step.expect;
    if (step.inspect === "debugInfo" && ex?.linesByFile) {
      for (const [file, markers] of Object.entries(ex.linesByFile)) {
        const b = buildOf(file)!;
        const want = markers
          .map((m) => resolve(b, file, m).line ?? -1)
          .sort((x, y) => x - y);
        const got = b.info!.lines[String(resolve(b, file, "").fileId)] ?? [];
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          bad.push(
            `${tag} lines of ${file}: got ${JSON.stringify(got)}, oracle ${JSON.stringify(want)}`,
          );
        }
      }
    }
    const asked = step.args?.lines;
    const answers = ex?.body?.breakpoints;
    if (step.request === "setBreakpoints" && Array.isArray(asked) && answers) {
      const file = step.args!.file!;
      const b = buildOf(file);
      if (!b) continue;
      asked.forEach((marker, i) => {
        const want = answers[i];
        const { line, fileId } = resolve(b, file, String(marker));
        if (want === undefined || line === undefined) return;
        const r = placeBreakpoint(b.info!, fileId, line);
        const wantLine = want.line
          ? resolve(b, file, want.line).line
          : undefined;
        const ok = want.verified
          ? r.verified && (wantLine === undefined || r.line === wantLine)
          : !r.verified &&
            (want.reason === undefined || r.reason === want.reason);
        if (!ok) {
          bad.push(
            `${tag} breakpoint ${String(marker)}: got ${JSON.stringify(r.verified ? { line: r.line } : r)}, oracle ${JSON.stringify(want)}`,
          );
        }
      });
    }
    const loc = ex?.location;
    if (
      step.event === "stopped" &&
      loc &&
      typeof loc.file === "string" &&
      typeof loc.line === "string"
    ) {
      const b = buildOf(loc.file);
      if (!b) continue;
      const { line, fileId } = resolve(b, loc.file, loc.line);
      const at = probesOf(b.info!)
        .filter((p) => p.file === fileId && p.line === line)
        .sort((x, y) => x.col - y.col);
      const probe =
        loc.col === undefined ? at[0] : at.find((p) => p.col === loc.col);
      const where = `${tag} stop ${loc.line}${loc.col ? `:${loc.col}` : ""}`;
      if (!probe) {
        bad.push(
          `${where}: no probe there (probes at cols ${at.map((p) => p.col).join(",")})`,
        );
        continue;
      }
      if (typeof loc.endLine === "string") {
        const endLine = resolve(b, loc.file, loc.endLine).line;
        if (probe.endLine !== endLine)
          bad.push(`${where}: endLine ${probe.endLine}, oracle ${endLine}`);
      }
      const frame = ex?.stack?.[0];
      const pou = b.info!.pous[probe.pou]!;
      if (frame?.pou !== undefined && frame.pou.toUpperCase() !== pou.name) {
        bad.push(`${where}: POU ${pou.name}, oracle ${frame.pou}`);
      }
      if (frame?.kind !== undefined && frame.kind !== pou.kind) {
        bad.push(`${where}: kind ${pou.kind}, oracle ${frame.kind}`);
      }
      if (typeof frame?.instance === "string") {
        const i = b.info!.instances.path.indexOf(frame.instance.toUpperCase());
        const owner = pou.owner === null ? pou : b.info!.pous[pou.owner]!;
        if (i < 0 || b.info!.instances.typeId[i] !== owner.typeId) {
          bad.push(
            `${where}: instance ${frame.instance} is not a ${owner.name}`,
          );
        }
      }
    }
  }
  return bad;
}

/**
 * Corpus markers on lines that are deliberately not executable: comments,
 * declarations, block ends and continuation lines of a spanning statement.
 */
const NON_EXECUTABLE_MARKERS: string[] = [];

describe.skipIf(!corpusPresent && CORPUS_ENV === undefined)(
  "debug-info.json: statement map against the corpus (A011, A015, A018)",
  () => {
    const compiled = (): Array<{ name: string; builds: CorpusBuild[] }> =>
      corpusNames
        .filter((n) => EXPECTED_FAIL[n] === undefined)
        .map((name) => ({
          name,
          builds: corpusBuilds(name).filter((b) => b.ok),
        }));

    it("puts every @MARKER line on a probe line, except deliberately non-executable ones", () => {
      const unlisted: string[] = [];
      const bad: string[] = [];
      for (const { name, builds } of compiled()) {
        const seen = new Set<string>();
        for (const b of builds) {
          bad.push(...lineInvariants(b));
          for (const f of b.info!.files) {
            if (seen.has(f.path)) continue;
            seen.add(f.path);
            const listed = new Set(b.info!.lines[String(f.id)] ?? []);
            const src = b.sources.find((s) => s.fileName === f.path)!.source;
            for (const [marker, line] of markersOf(src)) {
              if (!listed.has(line))
                unlisted.push(`${name}/${f.path} ${marker}`);
            }
          }
        }
      }
      expect(bad).toEqual([]);
      expect(unlisted.sort()).toEqual([...NON_EXECUTABLE_MARKERS].sort());
    });

    it("agrees with every oracle's line lists, placements and stop locations", () => {
      const bad: string[] = [];
      for (const { name, builds } of compiled()) {
        const oracles = fs
          .readdirSync(path.join(CORPUS_DIR, name))
          .filter((f) => f.endsWith(".oracle.json"));
        for (const o of oracles)
          bad.push(...oracleDisagreements(name, o, builds));
      }
      expect(bad).toEqual([]);
    });
  },
);

describe("debug-info.json: probe IDs (A012) and placement at POU edges (A018)", () => {
  const A = `
FUNCTION_BLOCK Helper
  VAR_INPUT x : INT; END_VAR
  VAR_OUTPUT y : INT; END_VAR
  METHOD PUBLIC Twice : INT
    Twice := x * 2;
    (* after the method's last statement *)
  END_METHOD
  y := x * 3;
  (* after the block's last statement *)
END_FUNCTION_BLOCK

FUNCTION Inc : INT
  VAR_INPUT v : INT; END_VAR
  Inc := v + 1;
END_FUNCTION
`;
  const B = `
PROGRAM Main
  VAR h : Helper; n : INT; k : INT; END_VAR
  h(x := n);
  n := Inc(n); k := h.Twice();
  WHILE n > 100 DO
    n := n - 100;
  END_WHILE;
  REPEAT
    k := k - 1;
  UNTIL k <= 0
  END_REPEAT;
END_PROGRAM
${CONFIG("Main")}`;
  const build = (a: string, b: string): DebugInfoV1 => {
    const r = compile(a, {
      fileName: "a.st",
      additionalSources: [{ fileName: "b.st", source: b }],
    });
    expect(r.errors).toEqual([]);
    return r.debugInfo!;
  };
  const tableHash = (info: DebugInfoV1): string =>
    createHash("sha256")
      .update(JSON.stringify({ probes: info.probes, lines: info.lines }))
      .digest("hex");
  const located = (info: DebugInfoV1, file: number): string[] =>
    probesOf(info)
      .filter((p) => p.file === file)
      .map(
        (p) =>
          `${info.pous[p.pou]!.name} ${p.line}:${p.col}-${p.endLine}:${p.endCol} k${p.kind}`,
      );

  it("gives byte-identical probe tables to rebuilds of identical source", () => {
    const first = build(A, B);
    debugInfoOf(ALL_SCOPES);
    const second = build(`${A} `.trimEnd() + "\n", `${B}`);
    expect(first.probes.line.length).toBeGreaterThan(0);
    expect(tableHash(second)).toBe(tableHash(first));
  });

  it("numbers probes by file, then POU declaration, then source position", () => {
    const info = build(A, B);
    const key = (p: ProbeRow): number[] => {
      const s = info.pous[p.pou]!.span!;
      return [p.file, s[0], s[1], p.line, p.col, p.kind];
    };
    const keys = probesOf(info).map(key);
    const sorted = [...keys].sort((x, y) => {
      for (let i = 0; i < x.length; i++)
        if (x[i] !== y[i]) return x[i]! - y[i]!;
      return 0;
    });
    expect(keys).toEqual(sorted);
    for (const pou of info.pous.filter((p) => !p.noSource)) {
      const own = probesOf(info).filter((p) => p.pou === pou.id);
      expect(pou.entryProbe, pou.name).toBe(own[0]?.id ?? null);
    }
  });

  it("keeps an edited build's other file and its statement locations; the IDs may move", () => {
    const before = build(A, B);
    const after = build(
      A,
      B.replace("  h(x := n);", "  n := n + 1;\n  h(x := n);"),
    );
    expect(after.files[0]!.sha256).toBe(before.files[0]!.sha256);
    expect(after.files[1]!.sha256).not.toBe(before.files[1]!.sha256);
    expect(after.build.buildId).not.toBe(before.build.buildId);
    expect(located(after, 0)).toEqual(located(before, 0));
    expect(located(after, 1).length).toBe(located(before, 1).length + 1);
  });

  it("gives loops a condition probe and never moves a breakpoint across a POU edge", () => {
    const info = build(A, B);
    const line = (file: string, text: string): number =>
      (file === "a.st" ? A : B).split("\n").findIndex((l) => l.includes(text)) +
      1;
    const kinds = (text: string): number[] =>
      probesOf(info)
        .filter((p) => p.file === 1 && p.line === line("b.st", text))
        .map((p) => p.kind);
    expect(kinds("WHILE n > 100")).toEqual([0, 1]);
    expect(kinds("REPEAT")).toEqual([0]);
    expect(kinds("UNTIL k <= 0")).toEqual([1]);
    expect(
      probesOf(info)
        .filter((p) => p.file === 1 && p.line === line("b.st", "n := Inc(n)"))
        .map((p) => p.col),
    ).toEqual([3, 16]);
    const at = (text: string): Placement =>
      placeBreakpoint(info, 0, line("a.st", text));
    expect(at("after the method's last")).toEqual({
      verified: false,
      reason: "NO_CODE",
    });
    expect(at("after the block's last")).toEqual({
      verified: false,
      reason: "NO_CODE",
    });
    expect(at("END_FUNCTION_BLOCK")).toEqual({
      verified: false,
      reason: "NO_CODE",
    });
    expect(at("VAR_INPUT x")).toMatchObject({
      verified: true,
      line: line("a.st", "y := x * 3"),
    });
    expect(
      info.pous[(at("Twice := x") as { probe: ProbeRow }).probe.pou],
    ).toMatchObject({ name: "TWICE", kind: "method" });
  });
});
