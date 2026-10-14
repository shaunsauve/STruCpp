/**
 * debug-info.json (ADR-002 D3): every corpus build validates against the
 * published schema, every declared variable is described in its scope with
 * its IEC type, and rich types carry their bounds, lengths and targets.
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
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import {
  serializeDebugInfo,
  type DebugInfoV1,
} from "../../src/backend/debug-info-gen.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";

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
  "generated-region":
    "the {strucpp generated} pragmas are not lexed yet (ADR-002 D6)",
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

/** Every build a corpus program defines: the main build and each variant. */
function corpusBuilds(
  name: string,
): Array<{ label: string; ok: boolean; info?: DebugInfoV1; error?: string }> {
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
    const [first, ...rest] = buildFiles.map((f) => ({
      fileName: f,
      source: fs.readFileSync(path.join(dir, f), "utf8"),
    }));
    try {
      const r = compile(first!.source, {
        fileName: first!.fileName,
        additionalSources: rest,
        libraries,
      });
      if (!r.success) {
        return { label, ok: false, error: r.errors[0]?.message ?? "failed" };
      }
      return { label, ok: true, ...(r.debugInfo ? { info: r.debugInfo } : {}) };
    } catch (e) {
      return { label, ok: false, error: String(e) };
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

    it("keeps the largest corpus program's debug-info within ADR-002 D9 (A021)", () => {
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
