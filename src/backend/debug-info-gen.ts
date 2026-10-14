// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project
/**
 * STruC++ debug-info generator: `debug-info.json`, major 1 (ADR-002 D3).
 *
 * See also:
 *   src/backend/debug-table-gen.ts - DebugMapV2 leaves, which instances and globals address.
 *   docs/debug-info.schema.json - the published schema for this file.
 *   docs/DEBUG_INFO.md - prose description of every field.
 */

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
  /** Index into the POU's `__dbg_locals` offset table; null until probes exist (ADR-001 D3). */
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

/**
 * Serialise with object keys sorted at every level and no whitespace, so equal
 * inputs give byte-identical files on every build path (ADR-002 D7).
 */
export function serializeDebugInfo(info: DebugInfoV1): string {
  return JSON.stringify(info, (_key, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, obj[k]]),
    );
  });
}
