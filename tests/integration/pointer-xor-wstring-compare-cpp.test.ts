/**
 * Two IEC runtime operators the corpus needs and the runtime did not have.
 *
 * Both defects are the same kind: the ST is valid, STruCpp translates it, and
 * the generated C++ does not compile. ST → C++ translation succeeded the whole
 * time, so a codegen-string assertion would have stayed green throughout —
 * every test here goes through g++ and runs the binary.
 *
 * 1. `p := ADR(v) XOR 16#7FFF000000000000` — CODESYS address math, and the only
 *    way ST can name an address it did not start from, which is how a
 *    fault-injection corpus builds a deliberately-dangling POINTER TO. ADR()
 *    becomes `&(v)`, so the naive translation is `(&v) ^ mask`, which C++ cannot
 *    express at all:
 *      - member-operator lookup never passes through a pointer to reach the
 *        pointee, so no member of the pointee is reachable from `(&v)`;
 *      - a free `operator^(T*, M)` is ill-formed outright, because [over.oper]
 *        requires every overloaded operator function to take at least one
 *        parameter of class or enumeration type, and both of those operands are
 *        a pointer and an integer.
 *    So the operation is a plain function template, `iec_addr_xor`, which the
 *    [over.oper] rule does not constrain.
 *
 * 2. `IF r_ws <> "" THEN` — comparing a WSTRING against a literal. IECWStringVar
 *    has `operator value_type()`, so this looks reachable, but template argument
 *    deduction never considers a user-defined conversion, so every cross-class
 *    comparison found NO candidate. iec_wstring.hpp even cited the STRING
 *    family's free operators as the reason it had none — a comment describing
 *    operators that were never written.
 *
 * The type families are asserted rather than sampled. An operator that worked for
 * IEC_DINT and not IEC_BOOL would have been reported as a defect again later, so
 * each test sweeps the whole family it claims to cover.
 *
 * Which brings the second round of the same story, and the reason this header is
 * worth re-reading: the first fix swept the POINTEE family and assumed the MASK
 * family, so every literal mask compiled and every variable mask (`ADR(v) XOR m`)
 * did not — the same defect one axis over. Both axes are swept now, along with
 * the ST spellings that never reached the operator at all: a left-associative
 * mask chain, and parentheses around the ADR(). The mask spelling the operator
 * deliberately does NOT take, `m XOR ADR(v)`, is pinned as such rather than
 * quietly reinterpreted — that is a value XOR, not address math.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import {
  hasGpp,
  RUNTIME_INCLUDE_PATH,
  cxxEnv,
  CXX_STD,
} from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const CFG = `
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

describeIfGpp("pointer address XOR — ADR(v) XOR mask", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-addrxor-"));
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Translate ST, build a binary that drives the program against the given C++
   * body, run it, and return stdout. The driver reports "ALL_OK" or the failing
   * assertions, so a diff names what broke rather than just a non-zero exit.
   */
  function run(source: string, driverBody: string, name: string): string {
    const result = compile(source, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);

    const dir = path.join(tempDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
    fs.writeFileSync(
      path.join(dir, "main.cpp"),
      `#include "generated.hpp"
#include <cstdio>
strucpp::Configuration_CONFIG0 g_config;
using namespace strucpp;
static int fails = 0;
static void expect_true(const char* what, bool cond) {
  if (!cond) { printf("FAIL %s\\n", what); ++fails; }
}
int main() {
${driverBody}
  printf("%s\\n", fails ? "FAILURES" : "ALL_OK");
  return fails ? 1 : 0;
}
`,
    );

    const bin = path.join(dir, name);
    execSync(
      `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" ` +
        `-o "${bin}" "${path.join(dir, "main.cpp")}" "${path.join(dir, "generated.cpp")}"`,
      { encoding: "utf-8", env: cxxEnv },
    );
    return execSync(`"${bin}"`, { encoding: "utf-8" }).trim();
  }

  /**
   * A program that XORs a mask into the address of each variable, through
   * `POINTER TO`. Mask 16#0 is used deliberately here: it exercises the emitted
   * expression for real, at run time, without inventing a dangling address the
   * test binary would then have to survive. The bit behaviour itself is
   * asserted against live addresses below.
   */
  function program(vars: string, ptrs: string, body: string): string {
    return `
PROGRAM Main
  VAR
${vars}
${ptrs}
  END_VAR
${body}
END_PROGRAM${CFG}`;
  }

  /**
   * Every elementary type whose ADR() the front end will accept on the left of
   * an XOR. STRING/WSTRING/TIME/DATE are absent because the analyzer refuses to
   * assign *anything* into a `POINTER TO` one of them — see "what the analyzer
   * does with a POINTER TO" below, which pins that gap with its real cause
   * rather than leaving a wrong story attached to it. The runtime operator
   * covers them all regardless; the test after the sweeps proves it at the level
   * the operator actually lives at.
   */
  const TYPES: ReadonlyArray<[string, string]> = [
    ["DINT", "42"],
    ["INT", "7"],
    ["SINT", "-3"],
    ["LINT", "123456789"],
    ["REAL", "1.5"],
    ["LREAL", "2.25"],
    ["BOOL", "TRUE"],
    ["BYTE", "16#A5"],
    ["WORD", "16#BEEF"],
    ["DWORD", "16#DEADBEEF"],
    ["LWORD", "16#0123456789ABCDEF"],
  ];

  it.each(TYPES)(
    "compiles and runs ADR(v) XOR mask on a POINTER TO %s",
    (type, init) => {
      // Every case uses the same variable names so the driver is uniform; STruCpp
      // upper-cases a leading letter and leaves the rest, so `x`/`px` are `X`/`PX`.
      const src = program(
        `    x : ${type} := ${init};`,
        `    px : POINTER TO ${type};`,
        `  px := ADR(x) XOR 16#0;`,
      );
      const out = run(
        src,
        `  g_config.INSTANCE0.run();
  expect_true("${type}: PX matches ADR(X) at mask 0",
             g_config.INSTANCE0.PX.to_addr()
                 == reinterpret_cast<uintptr_t>(&g_config.INSTANCE0.X));`,
        `addr_xor_${type.toLowerCase()}`,
      );
      expect(out).toBe("ALL_OK");
    },
  );

  /**
   * The mask family, swept separately from the pointee family above.
   *
   * A literal mask arrives at `iec_addr_xor` as a raw `int`/`uint64_t`, but an ST
   * *variable* mask arrives as an `IECVar<T>` — and `std::is_integral<M>` does
   * not hold for `IECVar<T>` however integral `T` is, so template deduction
   * found nothing and every `ADR(v) XOR m` with a variable mask was rejected by
   * g++ while the literal spelling was fine. That is the half-fix: one axis of
   * the operator's signature was swept, the other was assumed. Every integral
   * IEC type is in here so an overload that worked for LWORD and not for SINT
   * cannot recur.
   */
  const MASK_TYPES: ReadonlyArray<[string, string]> = [
    ["SINT", "16#20"],
    ["INT", "16#20"],
    ["DINT", "16#20"],
    ["LINT", "16#20"],
    ["BYTE", "16#20"],
    ["WORD", "16#20"],
    ["DWORD", "16#20"],
    ["LWORD", "16#20"],
    ["USINT", "16#20"],
    ["UINT", "16#20"],
    ["UDINT", "16#20"],
    ["ULINT", "16#20"],
  ];

  it.each(MASK_TYPES)(
    "compiles and runs ADR(v) XOR m with m a %s variable",
    (maskType, maskValue) => {
      // The mask is non-zero and asserted against the live address, so this
      // proves the mask was read and folded into the address — not merely that
      // something compiled. 16#20 needs no bit of the address cleared first: XOR
      // is exact, so `base ^ mask` is the expected pointer whatever `base` is.
      const src = program(
        `    x : DINT := 1;`,
        `    px : POINTER TO DINT;
    m : ${maskType} := ${maskValue};`,
        `  px := ADR(x) XOR m;`,
      );
      const out = run(
        src,
        `  g_config.INSTANCE0.run();
  uintptr_t base = reinterpret_cast<uintptr_t>(&g_config.INSTANCE0.X);
  expect_true("${maskType} mask folded into the address",
             g_config.INSTANCE0.PX.to_addr() == (base ^ uintptr_t(0x20)));`,
        `addr_xor_mask_${maskType.toLowerCase()}`,
      );
      expect(out).toBe("ALL_OK");
    },
  );

  /**
   * The chain and parenthesis shapes, swept as pairs of ST spelling and the
   * address the ST means.
   *
   * XOR is left-associative, so `ADR(x) XOR 16#1 XOR 16#2` is
   * `(ADR(x) XOR 16#1) XOR 16#2` — an XOR whose *left* operand is already an
   * address XOR, and the emitted `(... ^ mask) ^ mask` is a raw pointer against
   * an integer, which no operator can express. The masks fold instead, which is
   * the same value: XOR is associative on address bits.
   */
  it.each([
    ["ADR(x) XOR 16#1 XOR 16#2", 0x3],
    ["ADR(x) XOR 16#1 XOR 16#2 XOR 16#4 XOR 16#8", 0xf],
    ["((ADR(x)) XOR 16#1) XOR 16#2", 0x3],
    ["(ADR(x)) XOR (16#1 XOR 16#2)", 0x3],
  ])("compiles and runs %s", (expr, mask) => {
    const src = program(
      `    x : DINT := 1;`,
      `    px : POINTER TO DINT;`,
      `  px := ${expr};`,
    );
    const out = run(
      src,
      `  g_config.INSTANCE0.run();
  uintptr_t base = reinterpret_cast<uintptr_t>(&g_config.INSTANCE0.X);
  expect_true("chain folds to one address XOR",
             g_config.INSTANCE0.PX.to_addr() == (base ^ uintptr_t(${mask})));`,
      `addr_xor_chain_${mask.toString(16)}`,
    );
    expect(out).toBe("ALL_OK");
  });

  it("leaves the mask spelling alone: ADR on the right is not address math", () => {
    // `m XOR ADR(x)` is NOT the CODESYS idiom and is deliberately not folded
    // into one: it xors the *value* of m with the *address value* of x, which is
    // a number, not a pointer. It is also a shape that does not compile through
    // to C++ — the emitted `M ^ (&X)` is an IECVar against a raw pointer, and
    // the same [over.oper] rule that keeps `(&v) ^ mask` inexpressible applies
    // here too. That gap is named in iec_addr_xor's doc comment rather than
    // quietly reinterpreted, and this test pins the deliberate half of it: the
    // narrowing stays narrow, so no iec_addr_xor call is emitted.
    const result = compile(
      program(
        `    x : DINT := 1;
    m : LWORD := 16#20;`,
        `    o : LWORD;`,
        `  o := m XOR ADR(x);`,
      ),
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors.map((e) => e.message)).toEqual([]);
    // A value xor, so the plain bitwise `^` is emitted — no iec_addr_xor call.
    expect(result.cppCode).not.toContain("iec_addr_xor");
  });

  it("covers every runtime variable type and every integral mask type", () => {
    // The operator is a template over the pointee AND over the mask, so the
    // claim is about the whole runtime, not about the eleven types above. This
    // drives iec_addr_xor directly against one variable of every element type
    // the runtime carries — scalars, both string kinds, and the duration/date
    // types — so "works for DINT, not BOOL" cannot recur unnoticed, and then
    // against every spelling a mask actually arrives in: a raw integer, an
    // IECVar of each width and signedness, and __XWORD itself.
    const out = run(
      program(
        `    n : DINT := 0;`,
        `    p : POINTER TO DINT;`,
        `  p := ADR(n) XOR 16#0;`,
      ),
      `#include "iec_ptr.hpp"
#include "iec_var.hpp"
#include "iec_string.hpp"
#include "iec_wstring.hpp"
  g_config.INSTANCE0.run();

  IEC_BOOL     b;
  IEC_DINT     di;
  IEC_REAL     r;
  IEC_LWORD    lw;
  IEC_TIME     tm;
  IEC_DATE     dt;
  IEC_STRING   s;
  IEC_WSTRING  w;

  uintptr_t mask = uintptr_t(0x20);
  bool all = true;
  // Each type gets its own mask bit so a template that only really matched the
  // first type would show up as a mismatch rather than passing on the reuse.
  all = all && iec_addr_xor(&b,  uintptr_t(1) << 0) != &b;
  all = all && iec_addr_xor(&di, uintptr_t(1) << 1) != &di;
  all = all && iec_addr_xor(&r,  uintptr_t(1) << 2) != &r;
  all = all && iec_addr_xor(&lw, uintptr_t(1) << 3) != &lw;
  all = all && iec_addr_xor(&tm, uintptr_t(1) << 4) != &tm;
  all = all && iec_addr_xor(&dt, uintptr_t(1) << 5) != &dt;
  all = all && iec_addr_xor(&s,  uintptr_t(1) << 6) != &s;
  all = all && iec_addr_xor(&w,  uintptr_t(1) << 7) != &w;
  expect_true("every runtime variable type XORs", all);
  // And the round trip restores the exact original address for each.
  expect_true("round trip restores IEC_DINT",
              iec_addr_xor(iec_addr_xor(&di, uintptr_t(1) << 1), uintptr_t(1) << 1) == &di);
  expect_true("round trip restores IEC_STRING",
              iec_addr_xor(iec_addr_xor(&s, uintptr_t(1) << 6), uintptr_t(1) << 6) == &s);

  // The mask axis. An ST variable reaches the operator as an IECVar, which is
  // the spelling the ST-only path uses for every mask that is not a literal;
  // an overload constrained on the raw mask type alone found nothing here.
  IECVar<SINT_t>  ms;
  IECVar<INT_t>   mi;
  IECVar<DINT_t>   md;
  IECVar<LINT_t>   ml;
  IECVar<BYTE_t>  mu8;
  IECVar<WORD_t>  mu16;
  IECVar<DWORD_t> mu32;
  IECVar<ULINT_t> mu64;
  IECVar<BOOL_t>  mbool;
  IEC_XWORD       mxw;
  ms.set(0x01); mi.set(0x02); md.set(0x04); ml.set(0x08);
  mu8.set(0x10); mu16.set(0x20); mu32.set(0x40); mu64.set(0x80);
  mbool.set(true); mxw.set(uintptr_t(0x100));

  uintptr_t base = reinterpret_cast<uintptr_t>(&di);
  bool masks = true;
  masks = masks && iec_addr_xor(&di, ms)    != nullptr
                  && reinterpret_cast<uintptr_t>(iec_addr_xor(&di, ms)) == (base ^ 0x01);
  masks = masks && reinterpret_cast<uintptr_t>(iec_addr_xor(&di, mi)) == (base ^ 0x02);
  masks = masks && reinterpret_cast<uintptr_t>(iec_addr_xor(&di, md)) == (base ^ 0x04);
  masks = masks && reinterpret_cast<uintptr_t>(iec_addr_xor(&di, ml)) == (base ^ 0x08);
  masks = masks && reinterpret_cast<uintptr_t>(iec_addr_xor(&di, mu8)) == (base ^ 0x10);
  masks = masks && reinterpret_cast<uintptr_t>(iec_addr_xor(&di, mu16)) == (base ^ 0x20);
  masks = masks && reinterpret_cast<uintptr_t>(iec_addr_xor(&di, mu32)) == (base ^ 0x40);
  masks = masks && reinterpret_cast<uintptr_t>(iec_addr_xor(&di, mu64)) == (base ^ 0x80);
  // BOOL is integral, so a BOOL mask is accepted rather than rejected — and it
  // means what it says, flipping exactly the low bit. Same as a literal 16#1.
  masks = masks && reinterpret_cast<uintptr_t>(iec_addr_xor(&di, mbool)) == (base ^ 0x01);
  masks = masks && reinterpret_cast<uintptr_t>(iec_addr_xor(&di, mxw)) == (base ^ 0x100);
  expect_true("every integral mask type XORs", masks);
  // An IECVar mask round-trips through the same operator.
  expect_true("IECVar mask round trip",
              iec_addr_xor(iec_addr_xor(&di, mu32), mu32) == &di);
  // A masked-out mask is still a mask: value 0 leaves the address alone, so the
  // two spellings agree.
  IECVar<DWORD_t> zero;
  zero.set(0);
  expect_true("zero mask leaves the address alone",
              iec_addr_xor(&di, zero) == &di);`,
      "addr_xor_all_types",
    );
    expect(out).toBe("ALL_OK");
  });

  it("reads what the analyzer does with a POINTER TO, which is: nothing", () => {
    // Finding 2's correction. The comment this test used to carry claimed the
    // analyzer "infers ADR(x) XOR <literal> as BOOL and refuses POINTER TO
    // STRING/WSTRING/TIME/DATE". Measured on this tree, that is wrong twice over
    // and the assertion it backed (`toEqual(["Cannot assign BOOL to STRING"])`)
    // was pinning the wrong half as if it were the specification.
    //
    // What is actually true:
    //
    //  - The analyzer does not type a `POINTER TO X` as a pointer at all.
    //    `inferVariableType` resolves the variable to the *pointee's* name, so
    //    `px : POINTER TO DINT` is a plain DINT to it and `px : POINTER TO
    //    STRING` is a sizeBits-0 placeholder elementary named STRING. There is no
    //    pointer assignability check anywhere on this path.
    //  - So the acceptance of `POINTER TO DINT := b` (a BOOL) is not leniency
    //    about pointers, it is the ordinary BOOL→DINT widening applied to a
    //    scalar. It is a real hole — `PX = b` compiles to `IEC_Ptr::operator=`
    //    and lands the address 1 — but it is the analyzer's pointer typing, not
    //    anything to do with ADR or XOR, and it is NOT narrowed here: doing so is
    //    a language-semantics change (it would also have to start *allowing*
    //    `POINTER TO STRING := ADR(x)`, which is refused today for the same
    //    reason `POINTER TO STRING := 16#0` is).
    //  - The BOOL in the old message is real but incidental: it is what the
    //    binary-type table infers for `__XWORD XOR <int literal>`, and it is only
    //    what gets *printed*. Nothing is refused *because* it is BOOL — a DINT
    //    and a LWORD mask assign into `POINTER TO DINT` through the same path.
    //  - The four refused types are refused because their names are in neither
    //    ELEMENTARY_TYPES nor the widening table, so the placeholder never
    //    matches and never widens. It has nothing to do with the XOR: plain
    //    `px := ADR(x)` is refused identically, one message word apart.
    const acc = (vars: string, ptrs: string, body: string) =>
      compile(program(vars, ptrs, body), {
        headerFileName: "generated.hpp",
      }).errors.map((e) => e.message);

    // The hole, pinned rather than hidden: a BOOL is assignable into a
    // POINTER TO DINT, because the analyzer never sees a pointer.
    expect(
      acc(`    b : BOOL := TRUE;`, `    px : POINTER TO DINT;`, `  px := b;`),
    ).toEqual([]);
    expect(acc(``, `    px : POINTER TO DINT;`, `  px := TRUE;`)).toEqual([]);

    // The inference the old comment described, isolated from any pointer: it is
    // BOOL, and BOOL is what lands in the message — no more than that.
    expect(
      acc(`    x : DINT := 1;`, `    o : DINT;`, `  o := ADR(x) XOR 16#0;`),
    ).toEqual([]);

    // And the placeholder rule, with no XOR and no pointer in sight: a
    // STRING-literal's type is the same placeholder name, so it is accepted,
    // while an INT is not.
    expect(acc(``, `    px : POINTER TO STRING;`, `  px := 'lit';`)).toEqual(
      [],
    );
    expect(acc(``, `    px : POINTER TO STRING;`, `  px := 16#0;`)).toEqual([
      "Cannot assign INT to STRING",
    ]);
  });

  it.each(["STRING", "WSTRING", "TIME", "DATE"])(
    "refuses POINTER TO %s with or without the XOR, which is the point",
    (type) => {
      // Same program twice, once with `ADR(x)` alone and once with the XOR. If
      // the XOR were the cause the first would compile. It does not, and the
      // only difference between the two messages is the inferred type of the
      // right-hand side — __XWORD for a bare ADR(), BOOL for the XOR.
      const bare = compile(
        program(
          `    x : ${type};`,
          `    px : POINTER TO ${type};`,
          `  px := ADR(x);`,
        ),
        { headerFileName: "generated.hpp" },
      );
      expect(bare.errors.map((e) => e.message)).toEqual([
        `Cannot assign __XWORD to ${type}`,
      ]);

      const xored = compile(
        program(
          `    x : ${type};`,
          `    px : POINTER TO ${type};`,
          `  px := ADR(x) XOR 16#0;`,
        ),
        { headerFileName: "generated.hpp" },
      );
      expect(xored.errors.map((e) => e.message)).toEqual([
        `Cannot assign BOOL to ${type}`,
      ]);
    },
  );

  it("sets the address bits and reads back through the pointed-at variable", () => {
    // The mask is derived from the live address rather than hard-coded, so the
    // assertion cannot depend on where the allocator happened to put the
    // variable. Pick a bit position the address does not already have set: XOR
    // that bit in, prove the pointer moved exactly that much, XOR it back out,
    // and prove the pointer addresses the variable again — including that a
    // write through it lands in the variable itself.
    const src = program(
      `    v : DINT := 7;`,
      `    p : POINTER TO DINT;`,
      `  p := ADR(v) XOR 16#0;`,
    );
    const out = run(
      src,
      `  g_config.INSTANCE0.run();

  auto&   v = g_config.INSTANCE0.V;
  auto    base = reinterpret_cast<uintptr_t>(&v);
  // A bit position the address does not already carry.
  unsigned k = 0;
  while ((base >> k) & 1u) ++k;
  uintptr_t mask = uintptr_t(1) << k;

  auto* q = iec_addr_xor(&v, mask);
  expect_true("XOR moved the pointer", reinterpret_cast<uintptr_t>(q) == (base ^ mask));
  expect_true("XOR changed the pointer", reinterpret_cast<uintptr_t>(q) != base);

  auto* back = iec_addr_xor(q, mask);
  expect_true("XOR is reversible", back == &v);
  expect_true("reads back through the variable", *back == 7);

  *back = 42;
  expect_true("writes land in the variable", v.get() == 42);`,
      "addr_xor_bits",
    );
    expect(out).toBe("ALL_OK");
  });

  it("gives the same answer for the IEC_Ptr spelling as for the raw pointer", () => {
    // `p ^ mask` (IEC_Ptr, a class object, so member lookup reaches it) and
    // `iec_addr_xor(p.get(), mask)` (the raw-pointer form codegen emits) must
    // not drift apart.
    const src = program(
      `    v : DINT := 7;`,
      `    p : POINTER TO DINT;`,
      `  p := ADR(v) XOR 16#0;`,
    );
    const out = run(
      src,
      `  g_config.INSTANCE0.run();
  auto& v = g_config.INSTANCE0.V;
  IEC_Ptr<int> p(&v);
  uintptr_t mask = uintptr_t(0x40);

  expect_true("IEC_Ptr ^ agrees with iec_addr_xor",
              (p ^ mask).to_addr() == reinterpret_cast<uintptr_t>(iec_addr_xor(&v, mask)));`,
      "addr_xor_iecptr",
    );
    expect(out).toBe("ALL_OK");
  });

  it("leaves an ordinary value XOR alone", () => {
    // The special case is narrowed to ADR() on the left of XOR. A plain bitwise
    // XOR of two IEC values must still emit the `^` it always did, or this fix
    // would have silently changed unrelated programs.
    const out = run(
      `PROGRAM Main
  VAR
    a : DINT := 12;
    b : DINT := 10;
    o : DINT;
    lit : WORD := 16#00FF;
    ow : WORD;
  END_VAR
  o := a XOR b;
  ow := lit XOR 16#0F0F;
END_PROGRAM${CFG}`,
      `  g_config.INSTANCE0.run();
  expect_true("value XOR still bitwise", (int)g_config.INSTANCE0.O.get() == (12 ^ 10));
  expect_true("value XOR against a literal still bitwise",
              (int)g_config.INSTANCE0.OW.get() == (int)(0x00FF ^ 0x0F0F));`,
      "addr_xor_value_unchanged",
    );
    expect(out).toBe("ALL_OK");
  });
});

describeIfGpp(
  "WSTRING compared with a literal and with another WSTRING",
  () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-wstrcmp-"));
    });

    afterAll(() => {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    function run(source: string, driverBody: string, name: string): string {
      const result = compile(source, { headerFileName: "generated.hpp" });
      expect(result.errors.map((e) => e.message)).toEqual([]);

      const dir = path.join(tempDir, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
      fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
      fs.writeFileSync(
        path.join(dir, "main.cpp"),
        `#include "generated.hpp"
#include <cstdio>
strucpp::Configuration_CONFIG0 g_config;
using namespace strucpp;
static int fails = 0;
static void expect_true(const char* what, bool cond) {
  if (!cond) { printf("FAIL %s\\n", what); ++fails; }
}
int main() {
${driverBody}
  printf("%s\\n", fails ? "FAILURES" : "ALL_OK");
  return fails ? 1 : 0;
}
`,
      );

      const bin = path.join(dir, name);
      execSync(
        `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" ` +
          `-o "${bin}" "${path.join(dir, "main.cpp")}" "${path.join(dir, "generated.cpp")}"`,
        { encoding: "utf-8", env: cxxEnv },
      );
      return execSync(`"${bin}"`, { encoding: "utf-8" }).trim();
    }

    // Exactly the shape the retain-200 corpus program is built on, which is the
    // line that did not compile.
    const CMP_PROGRAM = `PROGRAM Main
  VAR
    ws : WSTRING := "retained";
    empty : WSTRING;
    ne : BOOL;
    eq : BOOL;
    eq_rev : BOOL;
    kept : DINT;
  END_VAR
  IF ws <> "" THEN kept := kept + 1; END_IF;
  ne := ws <> "";
  eq := ws = "retained";
  eq_rev := "retained" = ws;
END_PROGRAM${CFG}`;

    it('compiles a WSTRING <> "" and reports both answers correctly', () => {
      const out = run(
        CMP_PROGRAM,
        `  g_config.INSTANCE0.run();
  auto& i = g_config.INSTANCE0;
  // The required case: non-empty is <> "", so one leaf counted.
  expect_true("non-empty is <> \\"\\"", i.NE.get() == true);
  expect_true("non-empty counted", i.KEPT.get() == 1);
  expect_true("non-empty = \\"retained\\"", i.EQ.get() == true);
  expect_true("literal on the left", i.EQ_REV.get() == true);`,
        "wstr_cmp_nonempty",
      );
      expect(out).toBe("ALL_OK");
    });

    it('reports an empty WSTRING as = "" and not <> ""', () => {
      const out = run(
        `PROGRAM Main
  VAR
    empty : WSTRING;
    ne : BOOL;
    eq : BOOL;
    kept : DINT;
  END_VAR
  IF empty <> "" THEN kept := kept + 1; END_IF;
  ne := empty <> "";
  eq := empty = "";
END_PROGRAM${CFG}`,
        `  g_config.INSTANCE0.run();
  auto& i = g_config.INSTANCE0;
  expect_true("empty is NOT <> \\"\\"", i.NE.get() == false);
  expect_true("empty is = \\"\\"", i.EQ.get() == true);
  expect_true("empty counted nothing", i.KEPT.get() == 0);`,
        "wstr_cmp_empty",
      );
      expect(out).toBe("ALL_OK");
    });

    it("compares two WSTRINGs of different declared lengths", () => {
      // WSTRING(n) is parameterised, and codegen emits IECWStringVar<n> directly,
      // so a compare between two different lengths must deduce across both.
      const out = run(
        `PROGRAM Main
  VAR
    a : WSTRING(8) := "same";
    b : WSTRING(64) := "same";
    c : WSTRING(64) := "diff";
    same : BOOL;
    differ : BOOL;
  END_VAR
  same := a = b;
  differ := a <> c;
END_PROGRAM${CFG}`,
        `  g_config.INSTANCE0.run();
  auto& i = g_config.INSTANCE0;
  expect_true("equal across lengths", i.SAME.get() == true);
  expect_true("unequal across lengths", i.DIFFER.get() == true);`,
        "wstr_cmp_lengths",
      );
      expect(out).toBe("ALL_OK");
    });

    it("compares a WSTRING struct field, which presents as IECVar<IECWString>", () => {
      // A struct field reaches the comparison as IECVar<IECWString<N>>, a third
      // class again — the same reason iec_string.hpp carries that family.
      const out = run(
        `TYPE Tag : STRUCT
    text : WSTRING;
    hits : DINT;
  END_STRUCT;
END_TYPE
PROGRAM Main
  VAR
    t : Tag;
    hits : DINT;
  END_VAR
  t.text := "x";
  t.hits := 0;
  IF t.text <> "" THEN t.hits := t.hits + 1; END_IF;
END_PROGRAM${CFG}`,
        `  g_config.INSTANCE0.run();
  expect_true("struct field compares", g_config.INSTANCE0.T.HITS.get() == 1);`,
        "wstr_cmp_struct",
      );
      expect(out).toBe("ALL_OK");
    });

    it("orders two WSTRINGs", () => {
      // The ordering operators came across with the same family; a WSTRING is
      // orderable in IEC and a project comparing two of them would otherwise hit
      // the same gap.
      const out = run(
        `PROGRAM Main
  VAR
    a : WSTRING := "apple";
    b : WSTRING := "banana";
    lt : BOOL;
    gt : BOOL;
  END_VAR
  lt := a < b;
  gt := b > a;
END_PROGRAM${CFG}`,
        `  g_config.INSTANCE0.run();
  auto& i = g_config.INSTANCE0;
  expect_true("ordering holds", i.LT.get() == true && i.GT.get() == true);`,
        "wstr_order",
      );
      expect(out).toBe("ALL_OK");
    });
  },
);
