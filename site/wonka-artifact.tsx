import { artifactClass } from "./wonka-artifact.stylex.ts";
import { WonkaRelics } from "./wonka-relics.tsx";

/** A decorative print remains when scripting or GPU support is unavailable. */
export function WonkaArtifact() {
  return <>
    <div className={artifactClass("artifact")} data-wonka-artifact="" aria-hidden="true">
      <svg className={artifactClass("fallback")} viewBox="0 0 560 520" fill="none" focusable="false">
        <defs>
          <linearGradient id="oompa-hat-print" x1="110" y1="330" x2="420" y2="100" gradientUnits="userSpaceOnUse">
            <stop stopColor="currentColor" stopOpacity="0.25" />
            <stop offset="0.48" stopColor="#b8a5be" />
            <stop offset="0.72" stopColor="#94b4b1" />
            <stop offset="1" stopColor="#c8b895" />
          </linearGradient>
        </defs>
        <g transform="rotate(13 290 255)" stroke="url(#oompa-hat-print)" strokeWidth="0.8">
          <path d="M178 137C180 118 365 110 382 131L356 322C329 343 226 346 199 327Z" />
          <ellipse cx="280" cy="134" rx="102" ry="23" />
          <ellipse cx="280" cy="134" rx="96" ry="19" />
          <path d="M203 296C236 315 323 314 360 296M201 304C239 327 325 321 359 305M199 327C236 353 327 348 356 322" />
          <path d="M201 314C136 300 109 325 116 342C148 384 387 390 444 333C455 317 407 299 359 312M116 342C143 395 398 395 444 333" />
          {Array.from({ length: 23 }, (_, i) => {
            const x = 190 + i * 8;
            return <path key={i} d={`M${x} ${145 + Math.sin(i / 22 * Math.PI) * 12}Q${x + (280 - x) * 0.17} 229 ${x + (280 - x) * 0.22} ${295 + Math.sin(i / 22 * Math.PI) * 16}`} opacity="0.55" />;
          })}
          {Array.from({ length: 13 }, (_, i) => <path key={i} d={`M${182 + i * 1.4} ${158 + i * 10}Q280 ${181 + i * 10} ${378 - i * 1.35} ${153 + i * 10}`} opacity="0.26" />)}
        </g>
      </svg>
      <canvas className={artifactClass("canvas")} data-wonka-canvas="" width="560" height="520" />
    </div>
    <div className={artifactClass("seals")} aria-hidden="true"><WonkaRelics /></div>
  </>;
}
