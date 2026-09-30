import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { requirePiVersion } from "./anthropic-compat/pi-version.ts";
import { registerCompatibility } from "./anthropic-compat/runtime.ts";

export default function anthropicCompat(pi: ExtensionAPI): void {
  requirePiVersion("pi-anthropic-compat");
  registerCompatibility(pi);
}
