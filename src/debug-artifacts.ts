// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project
/**
 * The debug artefact file set of one build (ADR-002 D1, D7). Every build
 * path writes these bytes: the library caller, `strucpp --debug-artifacts`
 * and the editor, so the same inputs and options give identical files.
 *
 * See also:
 *   src/backend/debug-table-gen.ts - generated_debug.cpp and the DebugMapV2 behind debug-map.json.
 *   src/backend/debug-info-gen.ts - debug-info.json and its sorted-key serialiser.
 *   src/node/cli.ts - `--debug-artifacts <dir>` writes this set.
 */

import { serializeDebugInfo } from "./backend/debug-info-gen.js";
import type { CompileResult } from "./types.js";

export interface DebugArtifacts {
  "generated_debug.cpp": string;
  /** The editor's serialisation: two-space JSON, no trailing newline. */
  "debug-map.json": string;
  /** Sorted keys, no whitespace. */
  "debug-info.json": string;
  /** `PROGRAM_MD5`, as the runtime shim serves it on 0x45. */
  "defines.h": string;
}

/** Throws when the result carries no debug outputs (a failed compile). */
export function emitDebugArtifacts(result: CompileResult): DebugArtifacts {
  const { debugTableCpp, debugMap, debugInfo } = result;
  if (
    debugTableCpp === undefined ||
    debugMap === undefined ||
    debugInfo === undefined
  ) {
    throw new Error(
      "emitDebugArtifacts: the compile result has no debug table, debug map or debug info",
    );
  }
  return {
    "generated_debug.cpp": debugTableCpp,
    "debug-map.json": JSON.stringify(debugMap, null, 2),
    "debug-info.json": serializeDebugInfo(debugInfo),
    "defines.h": `#pragma once\n// Program MD5\n#define PROGRAM_MD5 "${debugInfo.build.md5}"\n`,
  };
}
