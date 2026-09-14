import { useId } from "react";
import { wonkaRelicClasses as classes } from "./wonka-relics.stylex.ts";

const seals = [
  {
    name: "ticket",
    x: 7,
    outline: "M6 9H30V13C26 13 26 19 30 19V23H6V19C10 19 10 13 6 13ZM11 11.5H25M11 20.5H25M12 14V18M24 14V18M16 16H20",
    foil: "M6 9H18M30 19V23H23M11 11.5H17M20 20.5H25M16 16H20",
    transform: "rotate(-8 18 17)",
  },
  {
    name: "cane",
    x: 51,
    outline: "M13 30L23 10C26 3 16 1 13 7C11 11 16 14 18.5 10M15 30L25 10C29 1 15-2 11 6M17 23L20 24.5M18.5 20L21.5 21.5M20 17L23 18.5M11.5 31H16.5",
    foil: "M23 10C26 3 16 1 13 7M17 23L20 24.5M20 17L23 18.5M11.5 31H16.5",
    transform: "translate(0 2)",
  },
  {
    name: "elevator",
    x: 95,
    outline: "M7 10L20 5L29 10V26L16 31L7 26ZM7 10L16 15L29 10M16 15V31M20 5V21L29 26M10 12V24L16 27M19 17L26 14V24L19 27ZM12 5V2M16 4V0",
    foil: "M7 10L20 5L29 10M16 15V31M19 27L26 24M12 5V2",
    transform: "translate(0 1)",
  },
  {
    name: "gobstopper",
    x: 139,
    outline: "M18 4C27 3 33 13 30 22C27 32 12 33 6 25C-1 15 7 5 18 4ZM17 8C24 6 30 13 27 21C25 28 15 31 9 24C3 17 8 10 17 8ZM18 12C24 10 27 17 23 22C20 27 12 26 10 21C8 16 13 12 18 12ZM18 16C22 15 23 19 20 22C17 24 13 21 14 18C15 17 16 16 18 16",
    foil: "M18 4C27 3 33 13 30 22M9 24C3 17 8 10 17 8M18 12C24 10 27 17 23 22M18 16C22 15 23 19 20 22",
    transform: "rotate(12 18 18)",
  },
] as const;

/** Original story emblems, printed as a quiet strip of interrupted metallic ink. */
export function WonkaRelics({ idPrefix = "oompa-relics" }: Readonly<{ idPrefix?: string }>) {
  const instance = useId().replace(/[^a-zA-Z0-9_-]/gu, "");
  const prefix = `${idPrefix.replace(/[^a-zA-Z0-9_-]/gu, "")}-${instance}`;
  const metal = `${prefix}-metal`;
  const spectrum = `${prefix}-spectrum`;

  return <svg
    aria-hidden="true"
    className={classes("strip")}
    data-wonka-relics=""
    fill="none"
    focusable="false"
    height="42"
    viewBox="0 0 180 42"
    width="180"
  >
    <defs>
      <linearGradient id={metal} x1="0%" x2="100%" y1="20%" y2="80%">
        <stop className={classes("champagne")} offset="0%" stopOpacity=".3" />
        <stop className={classes("lavender")} offset="29%" stopOpacity=".6" />
        <stop offset="48%" stopColor="currentColor" stopOpacity=".86" />
        <stop className={classes("champagne")} offset="58%" />
        <stop className={classes("teal")} offset="80%" stopOpacity=".7" />
        <stop offset="100%" stopColor="currentColor" stopOpacity=".22" />
      </linearGradient>
      <linearGradient id={spectrum} x1="0%" x2="100%" y1="100%" y2="0%">
        <stop className={classes("champagne")} offset="0%" stopOpacity="0" />
        <stop className={classes("champagne")} offset="32%" stopOpacity=".25" />
        <stop className={classes("lavender")} offset="46%" />
        <stop className={classes("teal")} offset="60%" />
        <stop className={classes("teal")} offset="83%" stopOpacity="0" />
      </linearGradient>
      {seals.map((seal) => <path d={seal.outline} id={`${prefix}-${seal.name}`} key={seal.name} />)}
    </defs>
    <g strokeLinecap="round" strokeLinejoin="round">
      {seals.map((seal) => <g key={seal.name} transform={`translate(${seal.x} 3)`}>
        <g transform={seal.transform}>
          <use className={classes("engraving")} href={`#${prefix}-${seal.name}`} stroke="currentColor" strokeWidth=".8" />
          <use className={classes("metal")} href={`#${prefix}-${seal.name}`} stroke={`url(#${metal})`} strokeWidth=".65" />
          <path className={classes("diffraction")} d={seal.foil} stroke={`url(#${spectrum})`} strokeDasharray="1.4 2.6 5.8 1.8" strokeWidth=".95" />
        </g>
      </g>)}
      <path className={classes("registration")} d="M47 20.5H48M91 20.5H92M135 20.5H136" stroke="currentColor" strokeWidth=".8" />
    </g>
  </svg>;
}
