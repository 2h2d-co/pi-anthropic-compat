import { VERSION } from "@earendil-works/pi-coding-agent";

export const MINIMUM_PI_VERSION = "0.99.1";

/** Compare dotted numeric release versions; prerelease suffixes rank below their release. */
export function atLeastVersion(version: unknown, minimum: string): boolean {
  if (typeof version !== "string") return false;
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version);
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
  const required = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const left = actual[index] ?? 0;
    const right = required[index] ?? 0;
    if (left !== right) return left > right;
  }
  return match[4] === undefined;
}

/**
 * Refuse to load on a Pi runtime older than the release this version targets.
 * Pi installs packages without resolving peer dependencies, so the peer range
 * alone does not stop an older Pi from loading the extension.
 */
export function requirePiVersion(extension: string, version: unknown = VERSION): void {
  if (atLeastVersion(version, MINIMUM_PI_VERSION)) return;
  const reported = typeof version === "string" ? `Pi ${version}` : "no Pi version";
  throw new Error(
    `${extension} requires Pi ${MINIMUM_PI_VERSION} or later, but the running Pi reports ` +
      `${reported}. Exit Pi and start Pi ${MINIMUM_PI_VERSION} or later. ` +
      "/reload cannot upgrade the running runtime.",
  );
}
