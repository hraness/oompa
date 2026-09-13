import {
  OOMPA_INSTALL_ARCHIVE_URL,
  OOMPA_INSTALL_BUN_VERSION,
  OOMPA_INSTALL_RUNTIME_INJECTION_ENVIRONMENT_NAMES,
  OOMPA_INSTALL_SUCCESS,
  installOompaRelease,
} from "./install-preflight-runtime";

export { OOMPA_INSTALL_ARCHIVE_URL, OOMPA_INSTALL_BUN_VERSION };

export const OOMPA_INSTALL_PREFLIGHT_SOURCE_URL =
  "https://raw.githubusercontent.com/hraness/oompa/v0.8.2/src/install-preflight-runtime.ts";
export const OOMPA_INSTALL_PREFLIGHT_SOURCE_SHA256 =
  "8945fab8bbf4685681915fe1d0045c3847e2c1ad5ce1e1ee2bb73ed012cd353f";
export const OOMPA_INSTALL_PREFLIGHT_SOURCE_MAXIMUM_BYTES = 512 * 1024;
export const OOMPA_INSTALL_PREFLIGHT_SUCCESS = OOMPA_INSTALL_SUCCESS;
export const OOMPA_INSTALL_PREFLIGHT_LOADER = [
  `const n=${JSON.stringify(OOMPA_INSTALL_RUNTIME_INJECTION_ENVIRONMENT_NAMES)},x=process.execArgv;`,
  "const c=x.filter(v=>v===\"-c\"||v.startsWith(\"--config\"));",
  "if(n.some(k=>process.env[k]!==undefined)||x.filter(v=>v===\"--no-env-file\").length!==1||c.length!==1||c[0]!==\"--config=/dev/null\"||x.some(v=>v.startsWith(\"-r\")||v===\"--preload\"||v.startsWith(\"--preload=\")||v===\"--require\"||v.startsWith(\"--require=\")||v===\"--import\"||v.startsWith(\"--import=\")||v===\"--env-file\"||v.startsWith(\"--env-file=\")))throw new Error(\"The tagged Oompa preflight requires a neutral Bun stage zero.\");",
  "const[a,h]=process.argv.slice(1);",
  "const r=Bun.stdin.stream().getReader(),q=[];let z=0;",
  `try{for(;;){const o=await r.read();if(o.done)break;z+=o.value.byteLength;if(z>${String(OOMPA_INSTALL_PREFLIGHT_SOURCE_MAXIMUM_BYTES)})throw new Error("The tagged Oompa preflight exceeds its byte limit.");q.push(o.value)}}finally{r.releaseLock()}`,
  "const b=new Uint8Array(z);let p=0;for(const v of q){b.set(v,p);p+=v.byteLength}",
  "const d=new Bun.CryptoHasher(\"sha256\").update(b).digest(\"hex\");",
  "if(d!==h)throw new Error(\"The tagged Oompa preflight digest is invalid.\");",
  "const j=new Bun.Transpiler({loader:\"ts\",target:\"bun\"}).transformSync(b);",
  "const u=URL.createObjectURL(new Blob([j],{type:\"text/javascript\"}));",
  "try{const m=await import(u);await m.installOompaRelease(a);process.stdout.write(`${m.OOMPA_INSTALL_SUCCESS}\\n`);}finally{URL.revokeObjectURL(u)}",
].join("");

export const buildOompaGlobalInstallCommand = (archive: string): string => {
  if (archive !== OOMPA_INSTALL_ARCHIVE_URL) {
    throw new Error("The public Oompa installer accepts only its exact immutable release archive URL.");
  }
  const unsetRuntimeInjection = OOMPA_INSTALL_RUNTIME_INJECTION_ENVIRONMENT_NAMES.join(" ");
  return `test "$(unset ${unsetRuntimeInjection} && curl -fsSL --connect-timeout 10 --max-time 60 --max-filesize ${String(OOMPA_INSTALL_PREFLIGHT_SOURCE_MAXIMUM_BYTES)} --retry 3 --retry-delay 1 --retry-max-time 60 --proto '=https' --tlsv1.2 ${OOMPA_INSTALL_PREFLIGHT_SOURCE_URL} | command bun --no-env-file --config=/dev/null -e '${OOMPA_INSTALL_PREFLIGHT_LOADER}' -- ${archive} ${OOMPA_INSTALL_PREFLIGHT_SOURCE_SHA256})" = ${OOMPA_INSTALL_PREFLIGHT_SUCCESS}`;
};

if (import.meta.main) {
  try {
    if (process.argv.length !== 3 || typeof process.argv[2] !== "string") {
      throw new Error("The Oompa installer requires exactly one release archive.");
    }
    await installOompaRelease(process.argv[2]);
    process.stdout.write(`${OOMPA_INSTALL_PREFLIGHT_SUCCESS}\n`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "The Oompa installation was refused.";
    process.stderr.write(`oompa install: ${message}\n`);
    process.exitCode = 1;
  }
}
