import { readFileSync } from "node:fs";
import { validateBluePluginManifestV1 } from "@dsh-blue/blue-api/protocol/v1";
const name = "billion-context-dsh-blue";
const inject = ["bluePluginHost"];
function loadManifest() {
  const source = JSON.parse(readFileSync(new URL("../blue.plugin.json", import.meta.url), "utf8"));
  const parsed = validateBluePluginManifestV1(source);
  if (!parsed.ok) {
    throw new TypeError(`invalid blue.plugin.json: ${parsed.issues[0]?.message ?? "unknown issue"}`);
  }
  return parsed.value;
}
function apply(ctx) {
  const opened = ctx.bluePluginHost.open(ctx, loadManifest());
  if (!opened.ok) ctx.logger.warn(`billion-context-dsh: Blue frontend admission failed: ${opened.message}`);
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=blue.js.map