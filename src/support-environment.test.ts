import { expect, test } from "bun:test";
import { allowlistedEnvironment as codexEnvironment } from "./codex/process";
import { allowlistedEnvironment as claudeEnvironment } from "./claude/process";

for (const [provider, filter] of [["codex", codexEnvironment], ["claude", claudeEnvironment]] as const) {
  test(`${provider} preserves explicit support suppression without broadening credential inheritance`, () => {
    const source = { HOME: "/synthetic/home", PATH: "/usr/bin", HRANESS_SUPPORT_AUDIENCE: "off", HRANESS_SUPPORT: "off", HRANESS_SUPPORT_EMAIL: "off", OPENAI_API_KEY: "synthetic-secret", ANTHROPIC_API_KEY: "synthetic-secret", HTTPS_PROXY: "synthetic-proxy" };
    const before = { ...source };
    expect(filter(source)).toEqual({ HOME: source.HOME, PATH: source.PATH, HRANESS_SUPPORT_AUDIENCE: "off", HRANESS_SUPPORT: "off", HRANESS_SUPPORT_EMAIL: "off" });
    expect(source).toEqual(before);
    expect(filter({ HOME: source.HOME }).HRANESS_SUPPORT_AUDIENCE).toBeUndefined();
  });
}
