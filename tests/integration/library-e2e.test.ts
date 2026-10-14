/**
 * E2E Library Pipeline Tests
 *
 * Exercises the full library lifecycle: build (.stlib) → compile program → g++ → run.
 * Verifies that custom and bundled libraries work end-to-end through the real toolchain.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { discoverStlibs } from "../../src/node/library-loader.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compileStlib } from "../../src/library/library-compiler.js";
import { compile } from "../../src/index.js";
import {
  hasGpp,
  createPCH,
  compileAndRunStandalone,
  runE2ETestPipeline,
} from "./test-helpers.js";

const LIBS_DIR = path.resolve(__dirname, "../../libs");

describe.skipIf(!hasGpp)("Library E2E Pipeline", () => {
  let tempDir: string;
  let pchPath: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-lib-e2e-"));
    pchPath = createPCH(tempDir);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("builds a custom library and compiles+runs a program against it", () => {
    // 1. Define and compile a simple FB library
    const libResult = compileStlib(
      [
        {
          source: `
            FUNCTION_BLOCK Adder
              VAR_INPUT
                A : INT;
                B : INT;
              END_VAR
              VAR_OUTPUT
                SUM : INT;
              END_VAR
              SUM := A + B;
            END_FUNCTION_BLOCK
          `,
          fileName: "adder.st",
        },
      ],
      { name: "adder-lib", version: "1.0.0", namespace: "adder" },
    );
    expect(libResult.success).toBe(true);

    // 2. Write .stlib to a temp subdirectory
    const libDir = path.join(tempDir, "libs-custom1");
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(
      path.join(libDir, "adder-lib.stlib"),
      JSON.stringify(libResult.archive),
    );

    // 3. Compile a user program that uses the FB
    const userSource = `
      PROGRAM Main
        VAR
          add : Adder;
        END_VAR
        add(A := 10, B := 32);
      END_PROGRAM
    `;
    const result = compile(userSource, {
      libraries: discoverStlibs(libDir),
    });
    expect(result.success).toBe(true);
    expect(result.headerCode).toBeTruthy();
    expect(result.cppCode).toBeTruthy();

    // 4. Compile+run — no stub headers needed since .stlib inlines C++ code
    const mainCode = `
#include "generated.hpp"
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << static_cast<int>(prog.ADD.SUM) << std::endl;
    return 0;
}
`;
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "lib_e2e_custom",
      mainCode,
    });
    expect(stdout).toBe("42");
  });

  it("builds a custom library and runs tests against it via test framework", () => {
    // 1. Build custom FB library
    const libResult = compileStlib(
      [
        {
          source: `
            FUNCTION_BLOCK Multiplier
              VAR_INPUT
                X : INT;
                Y : INT;
              END_VAR
              VAR_OUTPUT
                PRODUCT : INT;
              END_VAR
              PRODUCT := X * Y;
            END_FUNCTION_BLOCK
          `,
          fileName: "multiplier.st",
        },
      ],
      { name: "mul-lib", version: "1.0.0", namespace: "mul" },
    );
    expect(libResult.success).toBe(true);

    // 2. Write .stlib to disk
    const libDir = path.join(tempDir, "libs-custom2");
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(
      path.join(libDir, "mul-lib.stlib"),
      JSON.stringify(libResult.archive),
    );

    // 3. Source program + test ST (test framework instantiates programs locally)
    const sourceST = `
      PROGRAM TestMul
        VAR
          m : Multiplier;
        END_VAR
        m(X := 6, Y := 7);
      END_PROGRAM
    `;
    const testST = `
TEST 'multiplication result'
  VAR uut : TestMul; END_VAR
  uut();
  ASSERT_EQ(uut.m.PRODUCT, 42);
END_TEST
    `;

    // 4. Run through E2E test pipeline
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST,
      testST,
      testFileName: "test_multiplier.st",
      isTestBuild: true,
      tempDirPrefix: "strucpp-lib-e2e-mul-",
      compileOptions: {
        libraries: discoverStlibs(libDir),
      },
    });

    expect(stdout).not.toContain("[FAIL]");
    expect(exitCode).toBe(0);
  });

  it("builds a library with dependencies on another library", () => {
    // 1. Build Library A: BaseCounter
    const libAResult = compileStlib(
      [
        {
          source: `
            FUNCTION_BLOCK BaseCounter
              VAR_INPUT
                Enable : BOOL;
              END_VAR
              VAR_OUTPUT
                Count : INT;
              END_VAR
              VAR
                internal : INT;
              END_VAR
              IF Enable THEN
                internal := internal + 1;
              END_IF;
              Count := internal;
            END_FUNCTION_BLOCK
          `,
          fileName: "base_counter.st",
        },
      ],
      { name: "base-counter-lib", version: "1.0.0", namespace: "basectr" },
    );
    expect(libAResult.success).toBe(true);

    // 2. Build Library B depending on Library A: DoubleCounter
    const libBResult = compileStlib(
      [
        {
          source: `
            FUNCTION_BLOCK DoubleCounter
              VAR_INPUT
                Enable : BOOL;
              END_VAR
              VAR_OUTPUT
                Count : INT;
              END_VAR
              VAR
                ctr1 : BaseCounter;
                ctr2 : BaseCounter;
              END_VAR
              ctr1(Enable := Enable);
              ctr2(Enable := Enable);
              Count := ctr1.Count + ctr2.Count;
            END_FUNCTION_BLOCK
          `,
          fileName: "double_counter.st",
        },
      ],
      {
        name: "double-counter-lib",
        version: "1.0.0",
        namespace: "dblctr",
        dependencies: [libAResult.archive],
      },
    );
    expect(libBResult.success).toBe(true);

    // 3. Write both libraries to disk. Dependency code is stripped from
    //    archives so consumers must load all transitive dependencies.
    const libDir = path.join(tempDir, "libs-deps");
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(
      path.join(libDir, "base-counter-lib.stlib"),
      JSON.stringify(libAResult.archive),
    );
    fs.writeFileSync(
      path.join(libDir, "double-counter-lib.stlib"),
      JSON.stringify(libBResult.archive),
    );

    // 4. Compile user program
    const userSource = `
      PROGRAM Main
        VAR
          dc : DoubleCounter;
        END_VAR
        dc(Enable := TRUE);
      END_PROGRAM
    `;
    const result = compile(userSource, {
      libraries: discoverStlibs(libDir),
    });
    expect(result.success).toBe(true);

    // 5. Compile+run — no stub headers needed since .stlib inlines C++ code
    const mainCode = `
#include "generated.hpp"
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    prog.run();
    prog.run();
    std::cout << static_cast<int>(prog.DC.COUNT) << std::endl;
    return 0;
}
`;
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "lib_e2e_deps",
      mainCode,
    });
    // Each execute: both counters increment by 1, sum = 2. After 3 calls: 6
    expect(stdout).toBe("6");
  });

  // NO-FOLD: library scoping. A user POU named like a library POU shadows it
  // (normal and include-everything test builds); one a used library POU needs
  // is refused with both named.
  it("a user FB named PID shadows the library PID; shadowing one a library POU needs is an error naming both", () => {
    const libraries = discoverStlibs(LIBS_DIR);
    const userPid = `
      FUNCTION_BLOCK PID
        VAR_INPUT sp : REAL; END_VAR
        VAR_OUTPUT y : REAL; END_VAR
        y := sp * 2.0;
      END_FUNCTION_BLOCK
      PROGRAM Main
        VAR c : PID; o : REAL; t : TON; END_VAR
        c(sp := 1.5);
        o := c.y;
        t(IN := TRUE, PT := T#1s);
      END_PROGRAM
    `;
    const result = compile(userPid, { libraries });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.linkedPous?.filter((p) => p.name === "PID")).toEqual([
      { name: "PID", kind: "fb", library: null },
    ]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "lib_e2e_user_pid",
      mainCode: `
#include "generated.hpp"
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << static_cast<double>(prog.O) << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("3");

    const { stdout: testOut, exitCode } = runE2ETestPipeline({
      sourceST: userPid,
      testST: `
TEST 'user PID shadows the library PID'
  VAR uut : Main; END_VAR
  uut();
  ASSERT_EQ(uut.o, 3.0);
END_TEST
      `,
      testFileName: "test_user_pid.st",
      isTestBuild: true,
      tempDirPrefix: "strucpp-lib-e2e-user-pid-",
      compileOptions: { libraries },
    });
    expect(testOut).not.toContain("[FAIL]");
    expect(exitCode).toBe(0);

    // The library's PID is built on its own INTEGRAL: a user INTEGRAL cannot
    // stand in for it, so using the library PID is refused, naming both.
    const clash = compile(
      `
      FUNCTION_BLOCK INTEGRAL
        VAR_OUTPUT q : INT; END_VAR
        q := 1;
      END_FUNCTION_BLOCK
      PROGRAM Main
        VAR p : PID; END_VAR
        p(AUTO := TRUE);
      END_PROGRAM
    `,
      { libraries, fileName: "main.st" },
    );
    expect(clash.success).toBe(false);
    expect(clash.errors.map((e) => e.message)).toEqual([
      expect.stringMatching(
        /FUNCTION_BLOCK INTEGRAL .*main\.st:2.* library POU INTEGRAL \(additional-function-blocks\).*PID/,
      ),
    ]);
    expect(clash.errors[0]!.line).toBe(2);
  });

  it("bundled stdlib works via libraryPaths", () => {
    const sourceST = `
      PROGRAM TestCTU
        VAR
          counter : CTU;
          done : BOOL;
        END_VAR
        counter(CU := TRUE, R := FALSE, PV := 3);
        counter(CU := FALSE, R := FALSE, PV := 3);
        counter(CU := TRUE, R := FALSE, PV := 3);
        counter(CU := FALSE, R := FALSE, PV := 3);
        counter(CU := TRUE, R := FALSE, PV := 3);
        done := counter.Q;
      END_PROGRAM
    `;
    const testST = `
TEST 'CTU reaches preset'
  VAR uut : TestCTU; END_VAR
  uut();
  ASSERT_TRUE(uut.done);
  ASSERT_EQ(uut.counter.CV, 3);
END_TEST
    `;

    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST,
      testST,
      testFileName: "test_stdlib_ctu.st",
      isTestBuild: true,
      tempDirPrefix: "strucpp-lib-e2e-stdlib-",
      compileOptions: {
        libraries: discoverStlibs(LIBS_DIR),
      },
    });

    expect(stdout).not.toContain("[FAIL]");
    expect(exitCode).toBe(0);
  });
});
