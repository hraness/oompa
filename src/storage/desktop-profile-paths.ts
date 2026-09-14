import { isAbsolute, join, relative, resolve } from "node:path";

import type { DesktopProfilePaths } from "../domain/desktop-switch.ts";

export type { DesktopProfilePaths } from "../domain/desktop-switch.ts";

/**
 * The per-profile path triple the retained desktop-switch journal recorded.
 * The switch feature is gone; the derivation stays so stored journal rows can
 * still be checked against the exact profile boundaries they named.
 */
export function deriveDesktopProfilePaths(
  stateRoot: string,
  profileId: string,
): DesktopProfilePaths {
  if (!isAbsolute(stateRoot) || resolve(stateRoot) !== stateRoot) {
    throw new Error("INVALID_PROFILE: state root must be normalized and absolute");
  }
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(profileId)) {
    throw new Error("INVALID_PROFILE: profile id is not a safe path component");
  }
  const profilesRoot = join(stateRoot, "profiles");
  const profileRoot = join(profilesRoot, profileId);
  const relation = relative(profilesRoot, profileRoot);
  if (relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error("INVALID_PROFILE: profile path escapes the state root");
  }
  return {
    profileRoot,
    codexHome: join(profileRoot, "codex-home"),
    desktopUserData: join(profileRoot, "desktop-user-data"),
  };
}
