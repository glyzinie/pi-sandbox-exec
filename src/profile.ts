import type { SandboxPaths } from "./paths.ts";

export function buildSandboxProfile(paths: SandboxPaths): string {
  const writableFilters = paths.writableRoots
    .map((root) => `  (subpath ${JSON.stringify(root)})`)
    .join("\n");

  return `
(version 1)
(deny default)
(import "bsd.sb")

(allow process-fork)
(allow process-exec)
(allow signal (target self))
(deny process-info*)
(allow process-info* (target self))

; Permission decisions belong to a separate extension.
; This profile restricts writes, not reads or networking.
(allow file-read*)
(allow network*)

(allow file-write*
${writableFilters})
`;
}
