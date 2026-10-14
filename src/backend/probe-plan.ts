// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project
/**
 * STruC++ probe plan: the probe ID, kind and source range of every executable
 * statement, assigned once from the AST before code generation.
 *
 * Codegen looks IDs up here when it emits a statement and records them in
 * `lineMap`; the debug-info generator serialises the same plan as
 * `debug-info.json` `probes` and `lines`. One numbering feeds both.
 *
 * See also:
 *   src/backend/codegen.ts - records each planned probe in `lineMap` (`noteProbe`).
 *   src/backend/debug-info-gen.ts - serialises the plan into the statement map.
 *   docs/DEBUG_INFO.md - the `probes` and `lines` tables, and the numbering rules.
 */

import type {
  CompilationUnit,
  Expression,
  PropertyDeclaration,
  Statement,
} from "../frontend/ast.js";
import type { SourceSpan } from "../types.js";

/** 0 statement, 1 loop condition, 2 ELSIF condition. */
export type ProbeKind = 0 | 1 | 2;

/**
 * A body that owns probes. `key` is the AST object the debug-info generator
 * registers the POU under: the declaration node, or for a property accessor
 * its statement array.
 */
export interface ProbeBody {
  key: object;
  span: SourceSpan;
  statements: Statement[];
}

export interface PlannedProbe {
  body: object;
  file: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  kind: ProbeKind;
}

export interface ProbePlan {
  /** Index = probe ID. */
  probes: PlannedProbe[];
  /** Probe ID of `node` for `kind`, or undefined when the plan has none. */
  idOf(node: object, kind: ProbeKind): number | undefined;
}

/** Every body of the unit that holds statements, with its declaration span. */
export function probeBodies(ast: CompilationUnit): ProbeBody[] {
  const bodies: ProbeBody[] = [];
  const accessor = (
    prop: PropertyDeclaration,
    statements: Statement[] | undefined,
    span: SourceSpan | undefined,
  ): void => {
    if (statements) {
      bodies.push({
        key: statements,
        span: span ? { ...span, file: prop.sourceSpan.file } : prop.sourceSpan,
        statements,
      });
    }
  };
  for (const p of ast.programs) {
    bodies.push({ key: p, span: p.sourceSpan, statements: p.body });
  }
  for (const fb of ast.functionBlocks) {
    bodies.push({ key: fb, span: fb.sourceSpan, statements: fb.body });
    for (const m of fb.methods) {
      bodies.push({ key: m, span: m.sourceSpan, statements: m.body });
    }
    for (const prop of fb.properties) {
      accessor(prop, prop.getter, prop.getterSpan);
      accessor(prop, prop.setter, prop.setterSpan);
    }
  }
  for (const f of ast.functions) {
    bodies.push({ key: f, span: f.sourceSpan, statements: f.body });
  }
  return bodies;
}

/**
 * Numbers probes densely: files in compile order, then bodies by declaration
 * position, then statements in source order. The result
 * depends only on the source text, so identical sources give identical IDs.
 *
 * A compound statement's range is its header, keyword to the end of its
 * condition or selector; a loop condition probe shares it, except REPEAT's,
 * which spans UNTIL and its condition.
 */
export function planProbes(
  ast: CompilationUnit,
  fileOrder: string[],
): ProbePlan {
  const fileRank = (file: string): number => {
    const i = fileOrder.indexOf(file);
    return i < 0 ? fileOrder.length : i;
  };
  const bodies = probeBodies(ast).sort(
    (a, b) =>
      fileRank(a.span.file) - fileRank(b.span.file) ||
      a.span.startLine - b.span.startLine ||
      a.span.startCol - b.span.startCol,
  );

  const probes: PlannedProbe[] = [];
  const ids = [0, 1, 2].map(() => new Map<object, number>());
  let body: object = {};
  // Keyword spans (UNTIL, GET) carry no file name; a body's statements share its file.
  let bodyFile = "";

  const add = (
    node: object,
    kind: ProbeKind,
    from: SourceSpan,
    to: SourceSpan = from,
  ): void => {
    ids[kind]!.set(node, probes.length);
    probes.push({
      body,
      file: bodyFile,
      line: from.startLine,
      col: from.startCol,
      endLine: to.endLine,
      endCol: to.endCol,
      kind,
    });
  };
  const span = (e: Expression): SourceSpan => e.sourceSpan;

  const walk = (stmts: Statement[]): void => {
    for (const s of stmts) {
      switch (s.kind) {
        case "AssertCall":
          // Test-harness only; codegen emits nothing for it.
          break;
        case "IfStatement":
          add(s, 0, s.sourceSpan, span(s.condition));
          walk(s.thenStatements);
          for (const e of s.elsifClauses) {
            add(e, 2, e.sourceSpan, span(e.condition));
            walk(e.statements);
          }
          walk(s.elseStatements);
          break;
        case "CaseStatement":
          add(s, 0, s.sourceSpan, span(s.selector));
          for (const c of s.cases) walk(c.statements);
          walk(s.elseStatements);
          break;
        case "ForStatement": {
          const last = span(s.step ?? s.end);
          add(s, 0, s.sourceSpan, last);
          add(s, 1, s.sourceSpan, last);
          walk(s.body);
          break;
        }
        case "WhileStatement":
          add(s, 0, s.sourceSpan, span(s.condition));
          add(s, 1, s.sourceSpan, span(s.condition));
          walk(s.body);
          break;
        case "RepeatStatement": {
          const kw = s.sourceSpan;
          add(s, 0, {
            ...kw,
            endLine: kw.startLine,
            endCol: kw.startCol + "REPEAT".length - 1,
          });
          walk(s.body);
          add(s, 1, s.untilSpan ?? span(s.condition), span(s.condition));
          break;
        }
        default:
          add(s, 0, s.sourceSpan);
      }
    }
  };

  for (const b of bodies) {
    body = b.key;
    bodyFile = b.span.file;
    walk(b.statements);
  }

  return {
    probes,
    idOf: (node, kind) => ids[kind]!.get(node),
  };
}
