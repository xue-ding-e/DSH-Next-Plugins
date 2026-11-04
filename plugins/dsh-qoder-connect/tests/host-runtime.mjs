/**
 * Optional host peer resolution for this out-of-tree plugin.
 * Set DSH_TEST_RUNTIME to the host's dsh package directory. For an app.asar
 * runtime, use Electron with ELECTRON_RUN_AS_NODE=1. Otherwise installed peers
 * resolve normally. No credentials or running Host are required.
 */
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

if (process.env.DSH_TEST_RUNTIME) {
  const parentURL = pathToFileURL(join(process.env.DSH_TEST_RUNTIME, "package.json")).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith("@deepseek-ai/") || specifier.startsWith("@earendil-works/")) {
        return nextResolve(specifier, { ...context, parentURL });
      }
      return nextResolve(specifier, context);
    },
  });
}
