import { realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface SandboxPaths {
  readonly workspaceRoot: string;
  readonly writableRoots: readonly string[];
}

interface PathOptions {
  home?: string;
  temporaryRoots?: readonly string[];
}

export function canonicalDirectory(path: string): string {
  const canonical = realpathSync(resolve(path));
  if (!statSync(canonical).isDirectory()) {
    throw new Error(`Sandbox path is not a directory: ${path}`);
  }
  if (/[\x00-\x1f\x7f]/.test(canonical)) {
    throw new Error("Sandbox paths cannot contain control characters");
  }
  return canonical;
}

export function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function resolveSandboxPaths(
  launchCwd: string,
  {
    home = homedir(),
    temporaryRoots = [tmpdir(), "/tmp", "/var/tmp"],
  }: PathOptions = {},
): SandboxPaths {
  const homeRoot = canonicalDirectory(home);
  const workspaceRoot = canonicalDirectory(launchCwd);

  if (isInside(homeRoot, workspaceRoot)) {
    throw new Error(
      "Start Pi in a dedicated project directory, not the home directory or one of its ancestors",
    );
  }

  const tempRoots = temporaryRoots.map((path) => {
    const root = canonicalDirectory(path);
    if (isInside(homeRoot, root)) {
      throw new Error(`Temporary directory would expose the home directory: ${root}`);
    }
    return root;
  });

  // Resolve once per session. Re-resolving an allowed root after a symlink change
  // must not silently expand the next command's write permissions.
  return Object.freeze({
    workspaceRoot,
    writableRoots: Object.freeze([...new Set([workspaceRoot, ...tempRoots])]),
  });
}
