// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project
/**
 * Resolves `{strucpp generated}`, `{strucpp generated_begin}` and
 * `{strucpp generated_end}` pragma tokens of one source file into the
 * generated-code ranges of its compilation unit.
 *
 * See also:
 *   src/frontend/lexer.ts - GeneratedPragma, lexed into the `pragmas` group.
 *   src/backend/debug-info-gen.ts - sets the generated flag of probes and POUs in these ranges.
 */

import type { IToken } from "chevrotain";
import type { CompilationUnit, GeneratedRegion } from "./ast.js";
import type { SourceSpan } from "../types.js";

export interface PragmaError {
  message: string;
  line: number;
  column: number;
}

const before = (
  aLine: number,
  aCol: number,
  bLine: number,
  bCol: number,
): boolean => aLine < bLine || (aLine === bLine && aCol < bCol);

/** Ranges for `unit`, or errors for an unbalanced region or a POU pragma with no POU after it. */
export function resolveGeneratedPragmas(
  unit: CompilationUnit,
  pragmas: IToken[],
  file: string,
): { regions: GeneratedRegion[]; errors: PragmaError[] } {
  const regions: GeneratedRegion[] = [];
  const errors: PragmaError[] = [];
  const pous: SourceSpan[] = [
    ...unit.programs,
    ...unit.functionBlocks,
    ...unit.functions,
  ]
    .map((p) => p.sourceSpan)
    .sort((a, b) => a.startLine - b.startLine || a.startCol - b.startCol);
  let open: IToken | undefined;
  for (const t of pragmas) {
    const kind = /generated_begin/i.test(t.image)
      ? "begin"
      : /generated_end/i.test(t.image)
        ? "end"
        : "pou";
    const line = t.startLine ?? 0;
    const col = t.startColumn ?? 0;
    const at = { line, column: col };
    if (kind === "pou") {
      const next = pous.find((s) => before(line, col, s.startLine, s.startCol));
      if (next === undefined) {
        errors.push({
          message: "{strucpp generated} is not followed by a POU",
          ...at,
        });
      } else {
        regions.push({ span: { ...next, file }, pou: true });
      }
    } else if (kind === "begin") {
      if (open !== undefined) {
        errors.push({
          message: "{strucpp generated_begin} inside an open generated region",
          ...at,
        });
      }
      open = t;
    } else if (open === undefined) {
      errors.push({
        message:
          "{strucpp generated_end} has no matching {strucpp generated_begin}",
        ...at,
      });
    } else {
      regions.push({
        span: {
          file,
          startLine: open.startLine ?? 0,
          startCol: open.startColumn ?? 0,
          endLine: t.endLine ?? line,
          endCol: t.endColumn ?? col,
        },
        pou: false,
      });
      open = undefined;
    }
  }
  if (open !== undefined) {
    errors.push({
      message:
        "{strucpp generated_begin} has no matching {strucpp generated_end}",
      line: open.startLine ?? 0,
      column: open.startColumn ?? 0,
    });
  }
  return { regions, errors };
}

/** Whether `line:col` lies within `span`. */
export function spanContains(
  span: SourceSpan,
  line: number,
  col: number,
): boolean {
  return (
    !before(line, col, span.startLine, span.startCol) &&
    !before(span.endLine, span.endCol, line, col)
  );
}
