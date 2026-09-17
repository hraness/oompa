/*
 * Oompa's product profile for the Hraness credits service. `command` is argv,
 * never shell text; every command array the credits protocol prints starts
 * with it. The service origin can be overridden for local testing.
 */

export const CREDITS_PRODUCT_ID = "oompa";
export const CREDITS_PRODUCT_NAME = "Oompa";

export type OompaCreditsProfile = Readonly<{
  id: typeof CREDITS_PRODUCT_ID;
  name: typeof CREDITS_PRODUCT_NAME;
  command: readonly string[];
  serviceOrigin?: string;
}>;

export function creditsProfile(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OompaCreditsProfile {
  const serviceOrigin = env.OOMPA_CREDITS_SERVICE_ORIGIN;
  return {
    id: CREDITS_PRODUCT_ID,
    name: CREDITS_PRODUCT_NAME,
    command: ["oompa"],
    ...(serviceOrigin === undefined || serviceOrigin === "" ? {} : { serviceOrigin }),
  };
}

/** The command a person or agent reruns after paying; it also lifts the daemon's credits pause. */
export const HOSTED_AUTORESPOND_RESUME_ARGV: readonly string[] = Object.freeze([
  "oompa", "autorespond", "gateway", "set", "--hosted",
]);
