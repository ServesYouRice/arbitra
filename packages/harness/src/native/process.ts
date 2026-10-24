import { cliExecutableAt, hostNodeExecutable } from "@arbitra/providers/transports/cli/discovery.js";

/** The bounded process runner lives with the provider transports, which also start CLI processes. */
export * from "@arbitra/providers/process.js";

/** How a native executable is started: the program, and the arguments it takes before the harness's own. */
export interface NativeExecutable { readonly executable: string; readonly prefixArguments: readonly string[] }

/**
 * How to start the executable an operator named in `variable`, as the subscription CLI transport
 * starts its override. An npm install of Claude Code on Windows is a `claude.cmd` shim, which Node
 * refuses to start without a shell since its fix for CVE-2024-27980; through a shell cmd.exe would
 * parse the arguments again. The shim's Node script is run with Node instead, as is a JavaScript
 * entry point. A command file that is not an npm shim is refused.
 */
export async function nativeExecutable(path: string, variable: string): Promise<NativeExecutable> {
  const resolution = await cliExecutableAt(path, "override", { platform: process.platform, lookup: () => undefined, nodeExecutable: hostNodeExecutable() });
  if (!resolution.found) throw new Error(`NATIVE_HARNESS_EXECUTABLE_UNSUPPORTED:${variable}`);
  return Object.freeze({ executable: resolution.executable.command, prefixArguments: resolution.executable.prefixArguments });
}
