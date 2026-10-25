/**
 * How a host program is started, for code outside the transports: the native harness starts an operator's Claude Code
 * the way the subscription CLI transports start theirs, so an npm `claude.cmd` shim runs its Node script with Node.
 */
export { cliExecutableAt, hostNodeExecutable, type CliExecutable, type CliExecutableResolution, type DiscoveryHost } from "./transports/cli/discovery.js";
