// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project
/**
 * STruC++ debug-info generator: `debug-info.json`, format major 1.
 *
 * See also:
 *   src/backend/debug-table-gen.ts - DebugMapV2 leaves, which instances and globals address.
 *   docs/debug-info.schema.json - the published schema for this file.
 *   docs/DEBUG_INFO.md - prose description of every field.
 *   src/backend/sha256.ts - file hashes and the build identity.
 *   src/backend/probe-plan.ts - probe numbering, serialised here as `probes` and `lines`.
 */

import type {
  CompilationUnit,
  ReferenceKind,
  TypeReference,
  VarBlock,
  VarDeclaration,
} from "../frontend/ast.js";
import type { ProjectModel } from "../project-model.js";
import type { SymbolTables } from "../semantic/symbol-table.js";
import type { StlibArchive } from "../library/library-manifest.js";
import { isElementaryType } from "../semantic/type-registry.js";
import { evalIntConst, MAX_TYPE_ALIAS_DEPTH } from "../semantic/type-utils.js";
import { sha256Hex } from "./sha256.js";
import type { ProbePlan } from "./probe-plan.js";

export const DEBUG_INFO_FORMAT = "strucpp-debug-info";
export const DEBUG_INFO_MAJOR = 1;
export const DEBUG_INFO_MINOR = 0;

export type DebugTypeKind =
  | "fb"
  | "struct"
  | "array"
  | "enum"
  | "string"
  | "subrange"
  | "union"
  | "ref"
  | "elementary";

export interface DebugMember {
  name: string;
  typeId: number;
  /** IEC var block the member is declared in; null for a STRUCT field. */
  section: string | null;
  location: string | null;
  format: number | null;
}

export interface DebugType {
  id: number;
  kind: DebugTypeKind;
  /** Declared type name; null for an anonymous type. */
  name: string | null;
  members?: DebugMember[];
  /** Array bounds per dimension; null for a variable-length `*` dimension. */
  dims?: Array<[number, number] | null>;
  elem?: number;
  values?: Array<[string, number]>;
  length?: number;
  wide?: boolean;
  base?: number | null;
  range?: [number, number];
  target?: number | null;
  refKind?: "ref_to" | "reference_to" | "pointer_to" | "interface";
  extends?: number | null;
  opaque?: boolean;
}

export interface DebugLocal {
  name: string;
  typeId: number;
  /** IEC var block: VAR, VAR_INPUT, VAR_OUTPUT, VAR_IN_OUT, VAR_TEMP, VAR_INST. */
  kind: string;
  /** Index into the POU's `__dbg_locals` offset table; null until probe builds emit it. */
  localsSlot: number | null;
}

export interface DebugPou {
  id: number;
  name: string;
  kind: "program" | "fb" | "function" | "method";
  owner: number | null;
  file: number | null;
  span: [number, number, number, number] | null;
  entryProbe: number | null;
  noSource: boolean;
  noSourceReason: "library" | "binary" | "optout" | null;
  cppSymbol: string | null;
  generated: boolean;
  typeId: number | null;
  locals: DebugLocal[];
}

export interface DebugFile {
  id: number;
  path: string;
  sha256: string;
  library: string | null;
  generated: boolean;
}

export interface DebugProbes {
  pou: number[];
  file: number[];
  line: number[];
  col: number[];
  endLine: number[];
  endCol: number[];
  kind: number[];
  flags: number[];
  origin: number[];
}

export interface DebugInfoV1 {
  format: typeof DEBUG_INFO_FORMAT;
  major: typeof DEBUG_INFO_MAJOR;
  minor: number;
  build: {
    md5: string;
    buildId: string;
    compiler: string;
    options: Record<string, unknown>;
    time?: string;
    probes: boolean;
  };
  files: DebugFile[];
  pous: DebugPou[];
  probes: DebugProbes;
  lines: Record<string, number[]>;
  types: DebugType[];
  instances: {
    path: string[];
    typeId: number[];
    leafBase: Array<number | null>;
    leafBaseExt: Array<number | null>;
  };
  globals: Array<{
    name: string;
    typeId: number;
    location: string | null;
    leafBase: number | null;
  }>;
  externals: Array<{ pou: number; name: string; global: number | null }>;
  origins: Array<{ pou: string; kind: string; id: string }>;
  formats: unknown[];
}

/** JSON with object keys sorted at every level and no whitespace. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const obj = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, obj[k]]),
    );
  });
}

/**
 * Serialise with sorted keys, so equal inputs give byte-identical files on
 * every build path.
 */
export function serializeDebugInfo(info: DebugInfoV1): string {
  return canonicalJson(info);
}

// ---------------------------------------------------------------------------
// Build identity
// ---------------------------------------------------------------------------

/** Name of the debug-info file `debug-map.json`'s `debugInfo.file` links to. */
export const DEBUG_INFO_FILE = "debug-info.json";

export interface BuildIdentity {
  buildId: string;
  compiler: string;
  /** Canonical options, `debugProbes` always present. */
  options: Record<string, unknown>;
}

/**
 * SHA-256 over the compiler version, the canonical options, each source's
 * path and SHA-256, and each library's name, version and content hash.
 * Input-only, so it is known before code generation.
 */
export function computeBuildIdentity(input: {
  compilerVersion: string;
  /** Compile options that change generated code. */
  options: Record<string, unknown>;
  sources: Array<{ fileName: string; source: string }>;
  libraries: StlibArchive[];
}): BuildIdentity {
  const options = { debugProbes: false, ...input.options };
  const compiler = `strucpp ${input.compilerVersion}`;
  const buildId = sha256Hex(
    [
      compiler,
      canonicalJson(options),
      ...input.sources.map((f) => `${f.fileName}\n${sha256Hex(f.source)}`),
      ...input.libraries.map(
        (l) => `${l.manifest.name}\n${l.manifest.version}\n${archiveHash(l)}`,
      ),
    ].join("\n"),
  );
  return { buildId, compiler, options };
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/** What a loaded program reports about itself; a null `buildId` compares by md5 alone. */
export interface ProgramImage {
  md5: string | null;
  buildId: string | null;
}

export type DebugInfoRefusal =
  | {
      code: "UNSUPPORTED_DEBUG_INFO";
      message: string;
      details: { found: number | null; supported: number };
    }
  | {
      code: "STALE_BUILD";
      message: string;
      details: {
        reason: "source" | "build";
        expected: ProgramImage;
        found: ProgramImage;
      };
    };

export type DebugInfoReadResult =
  | { ok: true; info: DebugInfoV1 }
  | { ok: false; error: DebugInfoRefusal };

/**
 * Parse `debug-info.json`. Refuses another format or an unsupported major;
 * accepts any minor and keeps unknown properties unread. With `image`, also
 * refuses debug info of another build: md5 first (`source`), then buildId
 * (`build`).
 */
export function readDebugInfo(
  text: string,
  image?: ProgramImage,
): DebugInfoReadResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = null;
  }
  const obj =
    doc !== null && typeof doc === "object" && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : {};
  const major = obj["major"];
  const found =
    obj["format"] === DEBUG_INFO_FORMAT && Number.isInteger(major)
      ? (major as number)
      : null;
  if (found !== DEBUG_INFO_MAJOR) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_DEBUG_INFO",
        message:
          found === null
            ? `Not ${DEBUG_INFO_FORMAT} with an integer major version; this reader reads major ${DEBUG_INFO_MAJOR}.`
            : `The debug information is major version ${found}; this reader reads major ${DEBUG_INFO_MAJOR}.`,
        details: { found, supported: DEBUG_INFO_MAJOR },
      },
    };
  }
  const info = obj as unknown as DebugInfoV1;
  if (image) {
    const build = (info.build ?? {}) as Partial<DebugInfoV1["build"]>;
    const own: ProgramImage = {
      md5: build.md5 ?? null,
      buildId: build.buildId ?? null,
    };
    const reason =
      image.md5 !== own.md5
        ? "source"
        : image.buildId !== null && image.buildId !== own.buildId
          ? "build"
          : null;
    if (reason !== null) {
      return {
        ok: false,
        error: {
          code: "STALE_BUILD",
          message:
            reason === "source"
              ? `The debug information is for another program (md5 ${own.md5}, running ${String(image.md5)}).`
              : `The debug information is for another build of this program (buildId ${own.buildId}, running ${image.buildId}).`,
          details: { reason, expected: image, found: own },
        },
      };
    }
  }
  return { ok: true, info };
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export interface DebugInfoInput {
  ast: CompilationUnit;
  projectModel: ProjectModel;
  symbolTables: SymbolTables;
  /** `debug-map.json` leaf paths, in leaf order. */
  leafPaths: string[];
  /** User sources in compile order, as given to the compiler. */
  sources: Array<{ fileName: string; source: string }>;
  /** Program identity as served on 0x45. */
  md5: string;
  /** From `computeBuildIdentity`, so the debug table embeds the same id. */
  identity: BuildIdentity;
  globalConstants?: Record<string, number>;
  /** Probe numbering shared with codegen's `lineMap`. */
  probePlan: ProbePlan;
}

/** Var blocks stored in a program or FB instance; VAR_TEMP is frame storage, VAR_EXTERNAL a global. */
const INSTANCE_SECTIONS = new Set([
  "VAR",
  "VAR_INPUT",
  "VAR_OUTPUT",
  "VAR_IN_OUT",
]);

/** Capacity of an undeclared STRING / WSTRING, as codegen emits it. */
const DEFAULT_STRING_LENGTH = 254;

const archiveHashes = new WeakMap<StlibArchive, string>();

/** Content hash of a library archive, memoised: the same archive object is reused across compiles. */
function archiveHash(archive: StlibArchive): string {
  let hash = archiveHashes.get(archive);
  if (hash === undefined) {
    hash = sha256Hex(JSON.stringify(archive));
    archiveHashes.set(archive, hash);
  }
  return hash;
}

/** Index of the first leaf under every path prefix (instance, member or global). */
function firstLeafByPrefix(leafPaths: string[]): Map<string, number> {
  const first = new Map<string, number>();
  leafPaths.forEach((path, index) => {
    for (let i = 1; i < path.length; i++) {
      const ch = path[i];
      if (ch !== "." && ch !== "[") continue;
      const prefix = path.slice(0, i);
      if (!first.has(prefix)) first.set(prefix, index);
    }
    if (!first.has(path)) first.set(path, index);
  });
  return first;
}

export function generateDebugInfo(input: DebugInfoInput): DebugInfoV1 {
  const { ast, projectModel, symbolTables } = input;

  const files: DebugFile[] = input.sources.map((s, id) => ({
    id,
    path: s.fileName,
    sha256: sha256Hex(s.source),
    library: null,
    generated: false,
  }));
  const fileIdByName = new Map(files.map((f) => [f.path, f.id]));

  // --- Types ----------------------------------------------------------------

  const types: DebugType[] = [];
  const typeIdByKey = new Map<string, number>();
  const programByName = new Map(
    ast.programs.map((p) => [p.name.toUpperCase(), p]),
  );
  const interfaceNames = new Set(
    ast.interfaces.map((i) => i.name.toUpperCase()),
  );
  const libraryFbTypes: Array<{ name: string; typeId: number }> = [];
  const resolvingAliases = new Set<string>();

  /** Reserves the id before describing, so a type can reach itself through a reference. */
  const intern = (key: string, describe: (id: number) => DebugType): number => {
    const known = typeIdByKey.get(key);
    if (known !== undefined) return known;
    const id = types.length;
    typeIdByKey.set(key, id);
    types.push({ id, kind: "elementary", name: null });
    types[id] = describe(id);
    return id;
  };

  const stringType = (wide: boolean, length: number): number => {
    const base = wide ? "WSTRING" : "STRING";
    const name = length === DEFAULT_STRING_LENGTH ? base : `${base}(${length})`;
    return intern(`string:${name}`, (id) => ({
      id,
      kind: "string",
      name,
      length,
      wide,
    }));
  };

  const stringLength = (maxLength: number | string | undefined): number => {
    if (typeof maxLength === "number") return maxLength;
    if (typeof maxLength === "string") {
      const c = input.globalConstants ?? {};
      return (
        c[maxLength] ?? c[maxLength.toUpperCase()] ?? DEFAULT_STRING_LENGTH
      );
    }
    return DEFAULT_STRING_LENGTH;
  };

  /** Wraps `targetId` in reference levels, outermost first. */
  const refType = (chain: ReferenceKind[], targetId: number): number => {
    let id = targetId;
    for (const refKind of [...chain].reverse()) {
      if (refKind === "none") continue;
      const target = id;
      id = intern(`ref:${refKind}:${target}`, (rid) => ({
        id: rid,
        kind: "ref",
        name: null,
        target,
        refKind,
      }));
    }
    return id;
  };

  const arrayType = (
    name: string | null,
    dims: Array<[number, number] | null>,
    elemOf: () => number,
  ): number => {
    const describe = (id: number): DebugType => ({
      id,
      kind: "array",
      name,
      dims,
      elem: elemOf(),
    });
    if (name !== null) return intern(`name:${name}`, describe);
    // Anonymous arrays are keyed by shape; the element id is needed first.
    const elem = elemOf();
    return intern(`array:${JSON.stringify(dims)}:${elem}`, (id) => ({
      id,
      kind: "array",
      name: null,
      dims,
      elem,
    }));
  };

  const membersOf = (
    decls: VarDeclaration[],
    section: string | null,
  ): DebugMember[] =>
    decls.flatMap((decl) => {
      const typeId = typeOf(decl.type);
      return decl.names.map((name) => ({
        name,
        typeId,
        section,
        location: decl.address ?? null,
        format: null,
      }));
    });

  const instanceMembers = (blocks: VarBlock[]): DebugMember[] =>
    blocks
      .filter((b) => INSTANCE_SECTIONS.has(b.blockType))
      .flatMap((b) => membersOf(b.declarations, b.blockType));

  const typeOf = (tr: TypeReference): number => {
    const chain = (tr.referenceChain ?? [tr.referenceKind]).filter(
      (k) => k !== "none",
    );
    if (chain.length > 0) {
      const base: TypeReference = {
        ...tr,
        referenceKind: "none",
        isReference: false,
      };
      delete base.referenceChain;
      return refType(chain, typeOf(base));
    }
    if (tr.arrayDimensions && tr.elementTypeName !== undefined) {
      const elementName = tr.elementTypeName.toUpperCase();
      const elementChain = tr.elementReferenceChain ?? [];
      return arrayType(
        null,
        tr.arrayDimensions.map((d) => [d.start, d.end]),
        () => refType(elementChain, namedType(elementName)),
      );
    }
    const name = tr.name.toUpperCase();
    if (name === "STRING" || name === "WSTRING") {
      return stringType(name === "WSTRING", stringLength(tr.maxLength));
    }
    return namedType(name);
  };

  const namedType = (name: string): number => {
    const key = `name:${name}`;
    const known = typeIdByKey.get(key);
    if (known !== undefined) return known;
    if (name === "STRING" || name === "WSTRING") {
      return stringType(name === "WSTRING", DEFAULT_STRING_LENGTH);
    }
    if (isElementaryType(name)) {
      return intern(key, (id) => ({ id, kind: "elementary", name }));
    }

    const ts = symbolTables.lookupType(name);
    if (ts) {
      const def = ts.declaration.definition;
      const declaredName = ts.declaration.inline ? null : name;
      switch (def.kind) {
        case "StructDefinition":
          return intern(key, (id) => ({
            id,
            kind: "struct",
            name,
            members: membersOf(def.fields, null),
          }));
        case "EnumDefinition":
          return intern(key, (id) => {
            let next = 0;
            const values = def.members.map((m): [string, number] => {
              const v =
                m.value !== undefined ? (evalIntConst(m.value) ?? next) : next;
              next = v + 1;
              return [m.name, v];
            });
            return {
              id,
              kind: "enum",
              name: declaredName,
              values,
              base: def.baseType ? typeOf(def.baseType) : namedType("INT"),
            };
          });
        case "SubrangeDefinition": {
          const low = evalIntConst(def.lowerBound);
          const high = evalIntConst(def.upperBound);
          if (low === undefined || high === undefined) {
            return aliasOf(key, name, () => typeOf(def.baseType));
          }
          return intern(key, (id) => ({
            id,
            kind: "subrange",
            name: declaredName,
            base: typeOf(def.baseType),
            range: [low, high],
          }));
        }
        case "ArrayDefinition":
          return arrayType(
            name,
            def.dimensions.map((d) => {
              const lo = d.isVariableLength ? undefined : evalIntConst(d.start);
              const hi = d.isVariableLength ? undefined : evalIntConst(d.end);
              return lo === undefined || hi === undefined ? null : [lo, hi];
            }),
            () => typeOf(def.elementType),
          );
        case "TypeReference":
          // The library loader registers a struct it has no fields for as an alias of itself.
          if (def.name.toUpperCase() === name) return opaque(key, name);
          return aliasOf(key, name, () => typeOf(def));
      }
    }

    const fb = symbolTables.lookupFunctionBlock(name);
    if (fb) {
      if (fb.libraryName !== undefined) {
        const id = intern(key, (tid) => ({
          id: tid,
          kind: "fb",
          name,
          members: [
            ...membersOf(
              fb.inputs.map((v) => v.declaration),
              "VAR_INPUT",
            ),
            ...membersOf(
              fb.outputs.map((v) => v.declaration),
              "VAR_OUTPUT",
            ),
            ...membersOf(
              fb.inouts.map((v) => v.declaration),
              "VAR_IN_OUT",
            ),
          ],
          extends: null,
        }));
        if (!libraryFbTypes.some((l) => l.typeId === id)) {
          libraryFbTypes.push({ name, typeId: id });
        }
        return id;
      }
      const decl = fb.declaration;
      return intern(key, (id) => ({
        id,
        kind: "fb",
        name,
        members: instanceMembers(decl.varBlocks),
        extends:
          decl.extends !== undefined
            ? namedType(decl.extends.toUpperCase())
            : null,
      }));
    }

    const prog = programByName.get(name);
    if (prog) {
      return intern(key, (id) => ({
        id,
        kind: "fb",
        name,
        members: instanceMembers(prog.varBlocks),
        extends: null,
      }));
    }

    if (interfaceNames.has(name)) {
      return intern(key, (id) => ({
        id,
        kind: "ref",
        name,
        target: null,
        refKind: "interface",
      }));
    }
    return opaque(key, name);
  };

  const opaque = (key: string, name: string): number =>
    intern(key, (id) => ({
      id,
      kind: "struct",
      name,
      members: [],
      opaque: true,
    }));

  /** A TYPE alias takes its target's id; an alias cycle is described as opaque. */
  const aliasOf = (key: string, name: string, target: () => number): number => {
    if (
      resolvingAliases.has(name) ||
      resolvingAliases.size >= MAX_TYPE_ALIAS_DEPTH
    ) {
      return opaque(key, name);
    }
    resolvingAliases.add(name);
    const id = target();
    resolvingAliases.delete(name);
    typeIdByKey.set(key, id);
    return id;
  };

  // --- Globals ----------------------------------------------------------------

  const firstLeaf = firstLeafByPrefix(input.leafPaths);
  const globals: DebugInfoV1["globals"] = [];
  const globalIndex = new Map<string, number>();
  const globalBlocks = [
    ...ast.configurations.flatMap((c) => c.varBlocks),
    ...ast.globalVarBlocks,
  ].filter((b) => b.blockType === "VAR_GLOBAL");
  for (const block of globalBlocks) {
    for (const decl of block.declarations) {
      const typeId = typeOf(decl.type);
      for (const name of decl.names) {
        if (globalIndex.has(name)) continue;
        globalIndex.set(name, globals.length);
        globals.push({
          name,
          typeId,
          location: decl.address ?? null,
          leafBase: firstLeaf.get(name) ?? null,
        });
      }
    }
  }

  // --- POUs -------------------------------------------------------------------

  const pous: DebugPou[] = [];
  const pouIdByBody = new Map<object, number>();
  const externals: DebugInfoV1["externals"] = [];

  const localsOf = (
    blocks: VarBlock[],
    keep: (b: VarBlock) => boolean,
  ): DebugLocal[] =>
    blocks.filter(keep).flatMap((b) =>
      b.declarations.flatMap((decl) => {
        const typeId = typeOf(decl.type);
        return decl.names.map((name) => ({
          name,
          typeId,
          kind: b.blockType,
          localsSlot: null,
        }));
      }),
    );

  const addPou = (
    node: {
      name: string;
      varBlocks: VarBlock[];
      sourceSpan: CompilationUnit["sourceSpan"];
    },
    kind: DebugPou["kind"],
    owner: number | null,
    typeId: number | null,
    keepLocal: (b: VarBlock) => boolean,
    body: object = node,
  ): number => {
    const id = pous.length;
    pouIdByBody.set(body, id);
    const span = node.sourceSpan;
    pous.push({
      id,
      name: node.name,
      kind,
      owner,
      file: fileIdByName.get(span.file) ?? null,
      span: [span.startLine, span.startCol, span.endLine, span.endCol],
      // TODO: probe builds set cppSymbol and localsSlot (docs/DEBUG_INFO.md).
      entryProbe: null,
      noSource: false,
      noSourceReason: null,
      cppSymbol: null,
      generated: false,
      typeId,
      locals: localsOf(node.varBlocks, keepLocal),
    });
    for (const block of node.varBlocks) {
      if (block.blockType !== "VAR_EXTERNAL") continue;
      for (const decl of block.declarations) {
        for (const name of decl.names) {
          externals.push({
            pou: id,
            name,
            global: globalIndex.get(name) ?? null,
          });
        }
      }
    }
    return id;
  };

  const isTemp = (b: VarBlock): boolean => b.blockType === "VAR_TEMP";
  const isFrameVar = (b: VarBlock): boolean =>
    b.blockType !== "VAR_EXTERNAL" && b.blockType !== "VAR_GLOBAL";

  for (const prog of ast.programs) {
    addPou(prog, "program", null, namedType(prog.name.toUpperCase()), isTemp);
  }
  for (const fb of ast.functionBlocks) {
    const fbId = addPou(
      fb,
      "fb",
      null,
      namedType(fb.name.toUpperCase()),
      isTemp,
    );
    for (const method of fb.methods) {
      addPou(method, "method", fbId, null, isFrameVar);
    }
    // Accessors are bodies of their own (get_P / set_P in C++); named P.GET / P.SET.
    for (const prop of fb.properties) {
      const accessors: Array<
        [string, typeof prop.getter, typeof prop.getterSpan]
      > = [
        ["GET", prop.getter, prop.getterSpan],
        ["SET", prop.setter, prop.setterSpan],
      ];
      for (const [suffix, statements, span] of accessors) {
        if (!statements) continue;
        addPou(
          {
            name: `${prop.name}.${suffix}`,
            varBlocks: [],
            sourceSpan: span
              ? { ...span, file: prop.sourceSpan.file }
              : prop.sourceSpan,
          },
          "method",
          fbId,
          null,
          isFrameVar,
          statements,
        );
      }
    }
  }
  for (const fn of ast.functions) {
    addPou(fn, "function", null, null, isFrameVar);
  }

  // --- Statement map ---------------------------------------------------------

  const probes: DebugProbes = {
    pou: [],
    file: [],
    line: [],
    col: [],
    endLine: [],
    endCol: [],
    kind: [],
    flags: [],
    origin: [],
  };
  const lineSets = new Map<number, Set<number>>(
    files.map((f) => [f.id, new Set<number>()]),
  );
  input.probePlan.probes.forEach((p, id) => {
    const pou = pouIdByBody.get(p.body);
    const file = fileIdByName.get(p.file);
    if (pou === undefined || file === undefined) {
      throw new Error(`probe ${id} at ${p.file}:${p.line} has no POU or file`);
    }
    probes.pou.push(pou);
    probes.file.push(file);
    probes.line.push(p.line);
    probes.col.push(p.col);
    probes.endLine.push(p.endLine);
    probes.endCol.push(p.endCol);
    probes.kind.push(p.kind);
    // TODO: set the generated and locked flags (docs/DEBUG_INFO.md).
    probes.flags.push(0);
    probes.origin.push(-1);
    lineSets.get(file)!.add(p.line);
    pous[pou]!.entryProbe ??= id;
  });
  const lines: Record<string, number[]> = {};
  for (const [file, set] of lineSets) {
    lines[String(file)] = [...set].sort((a, b) => a - b);
  }

  // --- Instances --------------------------------------------------------------

  const instances: DebugInfoV1["instances"] = {
    path: [],
    typeId: [],
    leafBase: [],
    leafBaseExt: [],
  };
  const holdsInstance = new Map<number, boolean>();
  const holds = (typeId: number): boolean => {
    const known = holdsInstance.get(typeId);
    if (known !== undefined) return known;
    holdsInstance.set(typeId, false);
    const t = types[typeId]!;
    const result =
      t.kind === "fb" ||
      (t.kind === "array" && holds(t.elem!)) ||
      ((t.kind === "struct" || t.kind === "union") &&
        (t.members ?? []).some((m) => holds(m.typeId)));
    holdsInstance.set(typeId, result);
    return result;
  };

  const walkMembers = (path: string, t: DebugType): void => {
    if (t.extends !== undefined && t.extends !== null) {
      walkMembers(path, types[t.extends]!);
    }
    for (const m of t.members ?? []) {
      // An IN_OUT member refers to an instance owned elsewhere.
      if (m.section === "VAR_IN_OUT" || !holds(m.typeId)) continue;
      walkInstance(`${path}.${m.name}`, m.typeId);
    }
  };

  const walkElements = (
    path: string,
    dims: Array<[number, number] | null>,
    elem: number,
  ): void => {
    const [dim, ...rest] = dims;
    if (dim === undefined) {
      walkInstance(path, elem);
      return;
    }
    if (dim === null) return;
    for (let i = dim[0]; i <= dim[1]; i++) {
      walkElements(`${path}[${i}]`, rest, elem);
    }
  };

  const walkInstance = (path: string, typeId: number): void => {
    const t = types[typeId]!;
    if (t.kind === "fb") {
      instances.path.push(path);
      instances.typeId.push(typeId);
      instances.leafBase.push(firstLeaf.get(path) ?? null);
      // TODO: the second leaf pass over not-yet-covered sections sets leafBaseExt.
      instances.leafBaseExt.push(null);
    }
    if (t.kind === "array") walkElements(path, t.dims ?? [], t.elem!);
    else walkMembers(path, t);
  };

  for (const config of projectModel.configurations) {
    for (const resource of config.resources) {
      for (const task of resource.tasks) {
        for (const pi of task.programInstances) {
          const name = pi.programType.toUpperCase();
          if (!programByName.has(name)) continue;
          walkInstance(pi.instanceName.toUpperCase(), namedType(name));
        }
      }
    }
  }
  for (const g of globals) {
    if (holds(g.typeId)) walkInstance(g.name, g.typeId);
  }

  // Library blocks have no source here, but are still described.
  for (const lib of libraryFbTypes) {
    pous.push({
      id: pous.length,
      name: lib.name,
      kind: "fb",
      owner: null,
      file: null,
      span: null,
      entryProbe: null,
      noSource: true,
      noSourceReason: "library",
      cppSymbol: null,
      generated: false,
      typeId: lib.typeId,
      locals: [],
    });
  }

  // --- Build identity --------------------------------------------------------

  const { buildId, compiler, options } = input.identity;

  return {
    format: DEBUG_INFO_FORMAT,
    major: DEBUG_INFO_MAJOR,
    minor: DEBUG_INFO_MINOR,
    build: {
      md5: input.md5,
      buildId,
      compiler,
      options,
      probes: options.debugProbes === true,
    },
    files,
    pous,
    probes,
    lines,
    types,
    instances,
    globals,
    externals,
    origins: [],
    formats: [],
  };
}
