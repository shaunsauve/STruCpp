// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project
/**
 * Which user POU bodies can take a shared-global lock, directly or through
 * what they call. A property getter read through a shared global runs under
 * that global's lock, so codegen refuses one whose getter reaches another.
 *
 * Bodies are functions, FB main bodies, methods and property accessors. A
 * body reaches a lock when it names one of its VAR_EXTERNALs (an FB body:
 * those of its FB and every EXTENDS ancestor), or when it calls a function,
 * invokes an FB instance, calls a method or reads a property whose body does.
 * Library POUs have no AST body and cannot name the program's globals.
 *
 * See also:
 *   src/backend/codegen.ts - `refuseLockedGetter`, the only caller.
 *   src/semantic/type-utils.ts - member and array-element type resolution.
 *   src/ast-utils.ts - the AST walk.
 */

import type {
  ASTNode,
  CompilationUnit,
  Expression,
  FunctionBlockDeclaration,
  Statement,
  TypeReference,
  VarBlock,
} from "../frontend/ast.js";
import { walkAST } from "../ast-utils.js";
import {
  resolveArrayElementAccessType,
  resolveFieldDeclaration,
} from "../semantic/type-utils.js";

interface Body {
  /** Upper-case name shown in a refusal: `F`, `FB`, `FB.METHOD`, `FB.PROP`. */
  display: string;
  /** Upper-case VAR_EXTERNAL names visible in the body. */
  externals: Set<string>;
  /** Variable name → declared type name, upper-case. */
  vars: Map<string, string>;
  /** Enclosing FB, upper-case, for THIS and unqualified method calls. */
  owner: string | undefined;
  statements: Statement[];
}

interface Analysis {
  /** Why each reaching body reaches a lock, keyed like `bodies`. */
  reason: Map<string, string>;
  bodies: Map<string, Body>;
}

const cache = new WeakMap<CompilationUnit, Analysis>();

const fnKey = (name: string): string => `FN:${name.toUpperCase()}`;
const fbKey = (fb: string): string => `FB:${fb.toUpperCase()}`;
const methodKey = (fb: string, m: string): string =>
  `M:${fb.toUpperCase()}.${m.toUpperCase()}`;
const propKey = (fb: string, p: string): string =>
  `P:${fb.toUpperCase()}.${p.toUpperCase()}`;

function findFb(
  ast: CompilationUnit,
  name: string | undefined,
): FunctionBlockDeclaration | undefined {
  const upper = name?.toUpperCase();
  return ast.functionBlocks.find((f) => f.name.toUpperCase() === upper);
}

/** The FB and its EXTENDS ancestors, nearest first. */
function chain(
  ast: CompilationUnit,
  name: string | undefined,
): FunctionBlockDeclaration[] {
  const out: FunctionBlockDeclaration[] = [];
  let fb = findFb(ast, name);
  while (fb && !out.includes(fb)) {
    out.push(fb);
    fb = findFb(ast, fb.extends);
  }
  return out;
}

/** Declared type, or its element type for an array. */
function elementTypeName(ast: CompilationUnit, type: TypeReference): string {
  return (
    type.elementTypeName ??
    resolveArrayElementAccessType(type.name, ast)?.name ??
    type.name
  ).toUpperCase();
}

function addVars(
  ast: CompilationUnit,
  blocks: VarBlock[],
  vars: Map<string, string>,
  externals: Set<string>,
): void {
  for (const block of blocks) {
    for (const decl of block.declarations) {
      for (const name of decl.names) {
        const upper = name.toUpperCase();
        vars.set(upper, elementTypeName(ast, decl.type));
        if (block.blockType === "VAR_EXTERNAL") externals.add(upper);
      }
    }
  }
}

function collectBodies(ast: CompilationUnit): Map<string, Body> {
  const bodies = new Map<string, Body>();
  for (const fn of ast.functions) {
    const vars = new Map<string, string>();
    const externals = new Set<string>();
    addVars(ast, fn.varBlocks, vars, externals);
    bodies.set(fnKey(fn.name), {
      display: fn.name.toUpperCase(),
      externals,
      vars,
      owner: undefined,
      statements: fn.body,
    });
  }
  for (const fb of ast.functionBlocks) {
    const vars = new Map<string, string>();
    const externals = new Set<string>();
    // Ancestors first, so a redeclared member resolves to the nearest one.
    for (const f of chain(ast, fb.name).reverse()) {
      addVars(ast, f.varBlocks, vars, externals);
    }
    const owner = fb.name.toUpperCase();
    const body = (
      display: string,
      statements: Statement[],
      blocks: VarBlock[] = [],
    ): Body => {
      const v = new Map(vars);
      const e = new Set(externals);
      addVars(ast, blocks, v, e);
      return { display, externals: e, vars: v, owner, statements };
    };
    bodies.set(fbKey(fb.name), body(owner, fb.body));
    for (const m of fb.methods) {
      bodies.set(
        methodKey(fb.name, m.name),
        body(`${owner}.${m.name.toUpperCase()}`, m.body, m.varBlocks),
      );
    }
    for (const p of fb.properties) {
      bodies.set(
        propKey(fb.name, p.name),
        body(`${owner}.${p.name.toUpperCase()}`, [
          ...(p.getter ?? []),
          ...(p.setter ?? []),
        ]),
      );
    }
  }
  return bodies;
}

/** Key of the body defining `member` (method or property) in `fb`'s chain. */
function memberKey(
  ast: CompilationUnit,
  fb: string | undefined,
  member: string,
  kind: "method" | "property",
): string | undefined {
  const upper = member.toUpperCase();
  for (const f of chain(ast, fb)) {
    const list = kind === "method" ? f.methods : f.properties;
    if (list.some((m) => m.name.toUpperCase() === upper)) {
      return kind === "method"
        ? methodKey(f.name, upper)
        : propKey(f.name, upper);
    }
  }
  return undefined;
}

/** Type of a variable reference's root, `THIS` and `SUPER` included. */
function rootType(
  body: Body,
  ast: CompilationUnit,
  name: string,
): string | undefined {
  const upper = name.toUpperCase();
  if (upper === "THIS") return body.owner;
  if (upper === "SUPER") return findFb(ast, body.owner)?.extends?.toUpperCase();
  return body.vars.get(upper);
}

/** Bodies `body` can run, keyed like `collectBodies`, and the externals it names. */
function scan(
  body: Body,
  ast: CompilationUnit,
): { callees: string[]; named: string | undefined } {
  const callees: string[] = [];
  let named: string | undefined;
  const add = (key: string | undefined): void => {
    if (key !== undefined) callees.push(key);
  };
  const noteName = (name: string): void => {
    const upper = name.toUpperCase();
    if (named === undefined && body.externals.has(upper)) named = upper;
  };
  /** Type reached by a field path from a root type; properties on the way are callees. */
  const follow = (
    type: string | undefined,
    fields: string[],
  ): string | undefined => {
    let cur = type;
    for (const field of fields) {
      if (cur === undefined || /^\d+$/.test(field)) return undefined;
      const prop = memberKey(ast, cur, field, "property");
      if (prop !== undefined) {
        add(prop);
        return undefined;
      }
      const decl = resolveFieldDeclaration(cur, field, ast);
      cur = decl ? elementTypeName(ast, decl.type) : undefined;
    }
    return cur;
  };
  const typeOf = (expr: Expression): string | undefined =>
    expr.kind === "VariableExpression"
      ? follow(rootType(body, ast, expr.name), expr.fieldAccess)
      : undefined;

  const visit = (node: ASTNode): void => {
    switch (node.kind) {
      case "VariableExpression": {
        const v = node as Extract<Expression, { kind: "VariableExpression" }>;
        noteName(v.name);
        follow(rootType(body, ast, v.name), v.fieldAccess);
        break;
      }
      case "FunctionCallExpression": {
        const call = node as Extract<
          Expression,
          { kind: "FunctionCallExpression" }
        >;
        const upper = call.functionName.toUpperCase();
        const path = upper.split(".");
        noteName(path[0]!);
        if (path.length > 1) {
          // `inst.Method()` / `a.b.Method()` parse as one dotted name.
          const owner = follow(
            rootType(body, ast, path[0]!),
            path.slice(1, -1),
          );
          add(memberKey(ast, owner, path[path.length - 1]!, "method"));
        } else if (ast.functions.some((f) => f.name.toUpperCase() === upper)) {
          add(fnKey(upper));
        } else if (body.vars.has(upper)) {
          const t = body.vars.get(upper);
          if (findFb(ast, t)) add(fbKey(t!));
        } else {
          add(memberKey(ast, body.owner, upper, "method"));
        }
        break;
      }
      case "MethodCallExpression": {
        const call = node as Extract<
          Expression,
          { kind: "MethodCallExpression" }
        >;
        add(memberKey(ast, typeOf(call.object), call.methodName, "method"));
        break;
      }
    }
  };
  for (const stmt of body.statements) {
    walkAST(stmt, (n) => {
      visit(n);
    });
  }
  return { callees, named };
}

function analyse(ast: CompilationUnit): Analysis {
  const cached = cache.get(ast);
  if (cached) return cached;
  const bodies = collectBodies(ast);
  const reason = new Map<string, string>();
  const edges = new Map<string, string[]>();
  for (const [key, body] of bodies) {
    const { callees, named } = scan(body, ast);
    edges.set(key, callees);
    if (named !== undefined) reason.set(key, `reads VAR_EXTERNAL '${named}'`);
  }
  // Least fixed point over the call graph; recursion terminates because a
  // body's reason is set once.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, callees] of edges) {
      if (reason.has(key)) continue;
      for (const callee of callees) {
        const why = reason.get(callee);
        if (why === undefined) continue;
        reason.set(key, `calls '${bodies.get(callee)!.display}', which ${why}`);
        changed = true;
        break;
      }
    }
  }
  const analysis = { reason, bodies };
  cache.set(ast, analysis);
  return analysis;
}

/**
 * How the getter of `fb.prop` reaches a shared-global lock, as
 * "calls 'X', which reads VAR_EXTERNAL 'G'", or undefined when it cannot.
 */
export function getterLockReach(
  ast: CompilationUnit,
  fb: string,
  prop: string,
): string | undefined {
  const { reason, bodies } = analyse(ast);
  const key = memberKey(ast, fb, prop, "property");
  const accessor = key === undefined ? undefined : bodies.get(key);
  const property = chain(ast, fb)
    .flatMap((f) => f.properties)
    .find((p) => p.name.toUpperCase() === prop.toUpperCase());
  if (!accessor || !property?.getter) return undefined;
  const { callees, named } = scan(
    { ...accessor, statements: property.getter },
    ast,
  );
  if (named !== undefined) return `reads VAR_EXTERNAL '${named}'`;
  for (const callee of callees) {
    const why = reason.get(callee);
    if (why !== undefined) {
      return `calls '${bodies.get(callee)!.display}', which ${why}`;
    }
  }
  return undefined;
}
