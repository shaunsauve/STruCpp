/**
 * The openplc-editor's program build, reproduced for the parity test (A025):
 * split program.st per POU, compile with the editor's options, and write the
 * artefacts as the editor writes them.
 *
 * Mirrors openplc-editor 74a3e197:
 *   src/backend/shared/library/program-build-pipeline.ts:157-194 - split, then compile() options.
 *   src/backend/shared/library/program-build-pipeline.ts:263-280 - cppFiles, generated.hpp,
 *     generated_debug.cpp, debug-map.json as JSON.stringify(map, null, 2).
 *   src/backend/shared/compile/pipeline.ts:595 and editor-compiler-platform-port.ts:210-212 -
 *     md5 of the whole program.st text.
 *   src/middleware/shared/utils/library/compose-runtime-v4-bundle.ts:123 - defines.h.
 */

import { createHash } from "crypto";
import type { compile as Compile, CompileResult } from "../../../src/index.js";
import type { StlibArchive } from "../../../src/library/library-manifest.js";
import type { KnownPou, SplitProgramSt } from "./split-program-st.js";

export interface EditorBuild {
  /** The files the editor fed STruCpp, in order. */
  sources: Array<{ fileName: string; source: string }>;
  md5: string;
  /** File name to content, as written into the build directory. */
  files: Record<string, string>;
  result: CompileResult;
}

/** POUs as the editor's project knows them: every column-0 POU header. */
export function knownPous(programSt: string): KnownPou[] {
  return [
    ...programSt.matchAll(/^(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+(\w+)/gim),
  ].map((m) => ({
    name: m[2]!,
    kind: m[1]!.toUpperCase() as KnownPou["kind"],
  }));
}

export function editorBuild(
  programSt: string,
  libraries: StlibArchive[],
  compile: typeof Compile,
  splitProgramSt: (s: string, p: KnownPou[]) => SplitProgramSt | null,
): EditorBuild {
  const md5 = createHash("md5").update(programSt).digest("hex");
  const pous = knownPous(programSt);
  const split = pous.length > 0 ? splitProgramSt(programSt, pous) : null;
  const sources = split
    ? [...split.files.entries()].map(([fileName, source]) => ({
        fileName,
        source,
      }))
    : [{ fileName: "program.st", source: programSt }];
  const [first, ...rest] = sources;
  const result = compile(first!.source, {
    headerFileName: "generated.hpp",
    fileName: first!.fileName,
    debug: true,
    lineMapping: true,
    libraries,
    md5,
    pouIncludes: [],
    ...(rest.length > 0 ? { additionalSources: rest } : {}),
  });
  if (!result.success) {
    throw new Error(
      `editor build failed: ${result.errors.map((e) => e.message).join("; ")}`,
    );
  }
  const files: Record<string, string> = {};
  for (const f of result.cppFiles) files[f.name] = f.content;
  files["generated.hpp"] = result.headerCode;
  if (result.debugTableCpp !== undefined) {
    files["generated_debug.cpp"] = result.debugTableCpp;
  }
  if (result.debugMap !== undefined) {
    files["debug-map.json"] = JSON.stringify(result.debugMap, null, 2);
  }
  files["defines.h"] =
    `#pragma once\n// Program MD5\n#define PROGRAM_MD5 "${md5}"\n`;
  return { sources, md5, files, result };
}
