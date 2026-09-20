import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompatibility } from "./anthropic-compat/runtime.ts";

export default function anthropicCompat(pi: ExtensionAPI): void {
  registerCompatibility(pi);
}
