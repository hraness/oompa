import packageJson from "../package.json";
import { CLAUDE_PIN } from "../src/claude/pin";
import { buildOompaGlobalInstallCommand } from "../src/install-preflight";

export type EndpointAvailability = "beta-not-yet-live" | "live" | "release-ready";

export interface PublicEndpoints {
  readonly betaTag: EndpointAvailability;
  readonly githubRepository: EndpointAvailability;
  readonly hostedSync: EndpointAvailability;
  readonly website: EndpointAvailability;
}

export type InlineContent =
  | { readonly kind: "code"; readonly value: string }
  | { readonly kind: "link"; readonly href: string; readonly label: string }
  | { readonly kind: "text"; readonly value: string };

export interface OrderedListItem {
  readonly afterCommands?: readonly InlineContent[];
  readonly commands?: readonly string[];
  readonly content: readonly InlineContent[];
}

export type ContentBlock =
  | { readonly kind: "commands"; readonly commands: readonly string[] }
  | { readonly kind: "list"; readonly items: readonly (readonly InlineContent[])[] }
  | { readonly kind: "notice"; readonly label: string; readonly content: readonly InlineContent[] }
  | { readonly kind: "ordered-list"; readonly items: readonly OrderedListItem[] }
  | { readonly kind: "paragraph"; readonly content: readonly InlineContent[] }
  | { readonly kind: "subheading"; readonly text: string };

export interface ContentSection {
  readonly blocks: readonly ContentBlock[];
  readonly heading: string;
  readonly id: string;
}

export interface HeroFact {
  readonly detail: string;
  readonly label: string;
  readonly value: string;
}

export interface HeroStep {
  readonly command: string;
  readonly detail: string;
  readonly label: string;
}

export interface HeroPillar {
  readonly label: string;
  readonly summary: string;
}

export interface HeroContent {
  readonly boundary: string;
  /** A request a reader could make once Oompa is installed. */
  readonly example: string;
  readonly eyebrow: string;
  readonly facts: readonly HeroFact[];
  readonly heading: string;
  /** Three short statements shown under the hero. */
  readonly pillars: readonly HeroPillar[];
  readonly primaryAction: {
    readonly href: string;
    readonly label: string;
  };
  readonly proofLabel: string;
  readonly secondaryAction: {
    readonly href: string;
    readonly label: string;
  };
  readonly steps: readonly HeroStep[];
  readonly summary: string;
}

export interface Badge {
  readonly alt: string;
  readonly href: string;
  readonly image: string;
}

export interface SocialCard {
  /** Rendered card text; also the `og:image:alt` value. */
  readonly alt: string;
  readonly height: number;
  readonly path: string;
  readonly width: number;
}

export type HostedSignup = "invite_only" | "open";

export interface SiteQuestion {
  readonly answer: readonly InlineContent[];
  readonly question: string;
}

export interface SiteTrustItem {
  readonly detail: string;
  readonly label: string;
}

export interface SiteMaker {
  readonly bio: readonly InlineContent[];
  readonly heading: string;
  readonly links: readonly { readonly href: string; readonly label: string }[];
}

export interface PublicContent {
  /** README trust-signal badges, rendered on one line under the H1. */
  readonly badges: readonly Badge[];
  /** Qualified source-and-release positioning for package metadata, discovery, and llms.txt. */
  readonly description: string;
  /** Operational prerequisite for every current-daemon initialization or start example. */
  readonly daemonRolloutNotice: string;
  readonly doctorCommand: string;
  readonly endpoints: PublicEndpoints;
  readonly installCommand: string;
  readonly installNotice: string;
  readonly initCommand: string;
  readonly introduction: readonly ContentBlock[];
  readonly hero: HeroContent;
  /** Whether hosted sign-up needs an invitation. Drives every beta claim. */
  readonly hostedSignup: HostedSignup;
  /** The person behind Oompa, in plain words, for the website only. */
  readonly maker: SiteMaker;
  /** Reader objections answered on the website before the reference. */
  readonly questions: readonly SiteQuestion[];
  /** Local-by-design boundaries stated as reassurance on the website. */
  readonly trust: readonly SiteTrustItem[];
  readonly links: {
    readonly admittedInstall: string;
    readonly app: string;
    readonly contributing: string;
    readonly documentation: string;
    readonly github: string;
    readonly hraness: string;
    readonly privateSecurityReport: string;
    readonly privacy: string;
    readonly security: string;
  };
  readonly maintainer: {
    readonly name: string;
    readonly url: string;
  };
  readonly productName: string;
  /** Provider availability and its main capability limit, stated the same way everywhere. */
  readonly providerRoadmap: string;
  /** The exact CLI release named by the command; availability is stated separately. */
  readonly releaseVersion: string;
  readonly sections: readonly ContentSection[];
  readonly siteUrl: string;
  readonly socialCard: SocialCard;
  /** One-line release status shown directly under the thesis. */
  readonly statusLine: string;
  /** Category label used in the page title, hero eyebrow, and social card. */
  readonly tagline: string;
  /** The README thesis: what Oompa does, stated once, before any command. */
  readonly thesis: string;
}

const text = (value: string): InlineContent => ({ kind: "text", value });
const code = (value: string): InlineContent => ({ kind: "code", value });
const link = (label: string, href: string): InlineContent => ({ kind: "link", label, href });
const paragraph = (...content: readonly InlineContent[]): ContentBlock => ({
  kind: "paragraph",
  content,
});
const list = (...items: readonly (readonly InlineContent[])[]): ContentBlock => ({
  kind: "list",
  items,
});
const orderedList = (...items: readonly OrderedListItem[]): ContentBlock => ({
  kind: "ordered-list",
  items,
});

/**
 * The one place the public beta claim is decided. It must match the deployed
 * `serviceControl.newIdentityAdmissions` value: say "invite-only beta" while
 * the authority refuses an uninvited identity, and "open beta" only once it
 * admits one. Every surface below derives its wording from this constant.
 */
const hostedSignup: HostedSignup = "open";

/** The exact public wording for each hosted sign-up state. */
export const hostedSignupCopy = (signup: HostedSignup): Readonly<{
  admissionClaim: string;
  betaLabel: string;
}> => signup === "open"
  ? {
      admissionClaim: "Anyone can create an identity with an email address and a one-time code; an invitation is optional.",
      betaLabel: "open beta",
    }
  : {
      admissionClaim: "The first identity and device were admitted on the production deployment on 2026-09-03; new identities need an invitation from an existing member.",
      betaLabel: "invite-only beta",
    };

const {
  admissionClaim: hostedAdmissionClaim,
  betaLabel: hostedBetaLabel,
} = hostedSignupCopy(hostedSignup);

const links = {
  admittedInstall: "https://github.com/hraness/oompa/blob/main/docs/beta-release-notes.md#admitted-v080-canonical-artifact",
  app: "https://app.oompa.app",
  contributing: "https://github.com/hraness/oompa/blob/main/CONTRIBUTING.md",
  documentation: "https://oompa.app/docs/",
  github: "https://github.com/hraness/oompa",
  hraness: "https://hraness.com/",
  privateSecurityReport: "https://github.com/hraness/oompa/security/advisories/new",
  privacy: "https://github.com/hraness/oompa/blob/main/PRIVACY.md",
  security: "https://github.com/hraness/oompa/blob/main/SECURITY.md",
} as const;

const privacyBlocks: readonly ContentBlock[] = [
  paragraph(
    text("Cloud sync is optional. Local provider profiles, Codex credentials, Claude Code configuration and credentials, and local execution continue to work without it. Oompa identity is separate from every provider account."),
  ),
  { kind: "subheading", text: "Encrypted before upload" },
  list(
    [text("User messages and final assistant display text. This includes peer-session messages and their supplied reasons when Oompa records them as transcript messages.")],
    [text("Session names, notes, queued messages, and steering input.")],
    [text("Codex account labels and observed provider email and plan metadata when cloud sync is enabled. Claude Code account identity and usage are not projected. For managed profiles, Oompa validates one bounded Claude Code authentication-status response transiently, reduces it to signedIn, and never retains, returns, projects, or uploads the identity or usage fields. Personal-home Claude adoption transiently reads bounded account, email, and organization identity metadata and retains only a one-way local authority key. Raw Claude identity fields and that private authority key are never publicly returned, projected, or uploaded; Oompa never opens or parses a Claude credential file.")],
    [text("Codex and Claude Code personal-session adoption status: whether discovery is enabled and bounded pending, adopted, and fenced counts. Candidate identities and records are never included.")],
    [text("Turn timing, observed model and tier, and provider usage summaries.")],
    [text("Bounded observed file and Git metadata, without unbounded filesystem paths.")],
    [text("Observation-only interaction IDs, kinds, states, revisions, blocking status, and bounded safe summaries.")],
    [text("Remote-command input and results that fit the closed command protocol.")],
    [text("Canonical Oh operations, including their page records and provenance, terminal-head proofs, portable adoption proofs, and hosted-space descriptors for projects the owner explicitly enrolls in hosted memory.")],
    [text("A bounded read-only memory summary containing portable space and project labels, exact head and sync metadata, record counts and recent record keys, effective peer policies, and content-free recent peer-action state. Authenticated coverage markers distinguish complete from bounded selections. This summary excludes page bodies, peer message text, action reasons, raw local project or session IDs, paths, and Oh operation bytes.")],
    [text("For an explicitly requested Codex web login, the provider HTTPS verification URL and separate one-time user code. Oompa encrypts both to the account key before upload, lets only the requesting browser read them once, and deletes the hosted handoff on that read or after five minutes.")],
  ),
  { kind: "subheading", text: "Never uploaded" },
  list(
    [text("Codex or Claude Code credentials; provider profile or configuration files; plugin credentials; OAuth access or refresh tokens; authorization codes; PKCE verifiers; provider cookies; or the private device code.")],
    [text("Raw Codex app-server or Claude Code stream requests or responses.")],
    [text("Personal-home adoption candidate identities or records, personal-runtime bindings, process identities, schedule-source metadata, provider-home provenance, provider-account authority hashes, or the automation id, firing time, and instructions from an exact Codex Desktop heartbeat envelope. Such an envelope is replaced with generic protected text before session content is projected.")],
    [text("Raw reasoning, hidden chain of thought, or approval secrets.")],
    [text("Provider-internal login and request IDs, permission values, MCP field contracts, protected answers, or response digests.")],
    [text("Environment variables, arbitrary command output, or unbounded filesystem paths.")],
    [text("Working-memory Oh records and database bytes; canonical operations or page bodies outside their encrypted operation envelopes; and local Oh database paths.")],
  ),
  paragraph(
    text("The sync service necessarily sees the verified Oompa email address, device identifiers, opaque hosted-space identifiers, record types, revisions and key versions, ciphertext sizes, timestamps, execution-lease or command lifecycle metadata, and canonical-memory sequences plus keyed head tokens. It cannot decrypt session or memory content without a paired device key. Email access alone does not recover that key."),
  ),
  paragraph(
    text("A browser device holds the account key and decrypted projection only in that tab's memory by default. Oompa does not programmatically write decrypted provider or session text to the clipboard, but browser extensions, accessibility APIs, screenshots, and explicit user selection can observe rendered text."),
  ),
  paragraph(
    text("The website and app save your theme and appearance choices in this browser. This record contains only those two choices and is not sent to Oompa."),
  ),
  paragraph(
    text("Oompa uses Convex to authenticate the Oompa identity and store server-visible metadata plus encrypted projections. Convex receives the verified email address and the service metadata described above, but not the keys required to decrypt session content."),
  ),
  paragraph(
    text("Oompa uses Resend to deliver verification email. Resend receives the recipient email address, sender identity, one-time verification code and message content, and ordinary delivery metadata. It receives no provider credentials or encrypted session projection."),
  ),
  paragraph(
    text("Oompa uses anonymous, cookieless PostHog analytics on the public oompa.app pages to count page views and page leaves and measure selected Web Vitals. Collection runs only on the canonical production host, honors Do Not Track, keeps its visitor identifier in memory, and disables person profiles, autocapture, heatmaps, feature flags, surveys, conversations, and session recording. PostHog receives the canonical route, bounded referral classification, browser performance measurements, a cookieless visitor identifier, and ordinary request metadata such as IP address, user agent, and time. Oompa sends no form values, account identity, provider or session data, URL query, or fragment. Vercel serves oompa.app, and GitHub hosts the source repository, releases, and release downloads; those providers receive ordinary request metadata when visited."),
  ),
  paragraph(
    text("Device credentials are bearer credentials, not hardware-bound proofs. Connection and generation fencing blocks a copied credential from creating a second concurrent connection or surviving revocation, but an uncontested, unrevoked copy can impersonate that device until it is detected and revoked."),
  ),
  paragraph(
    text("Compact-projection recovery is append-only. It preserves every older encrypted cloud chunk, opens a new stream epoch, and keeps the acknowledged unsynced interval visible as a recovery gap until authenticated account deletion."),
  ),
  paragraph(
    text("Codex activity remains subject to OpenAI's service and privacy terms. Claude Code activity remains subject to Anthropic's service and privacy terms."),
  ),
  {
    kind: "notice",
    label: "Hosted sync status",
    content: [
      text(`The hosted sync endpoint is live as an ${hostedBetaLabel}. Authenticated account deletion and capability-only progress recovery are implemented and pass deterministic hostile tests. ${hostedAdmissionClaim}`),
    ],
  },
];

export const siteDocumentPaths: readonly string[] = [
  "/",
  "/docs/",
  "/docs/start/",
  "/docs/web/",
  "/docs/sessions/",
  "/docs/reference/",
  "/docs/status/",
  "/privacy/",
];

export const publicReleaseState: "live" | "release-ready" | "staged" = "staged";

const betaInstallCommand = buildOompaGlobalInstallCommand(
  "https://github.com/hraness/oompa/releases/download/v0.8.1/hraness-oompa-0.8.1.tgz",
);

const productName = "Oompa";
const tagline = "Workspace for Codex and Claude Code";
const providerRoadmap = "Codex and Claude Code, side by side.";
const releaseVersion = "0.8.1";
export const admittedReleaseVersion = "0.8.0";
const admittedReleaseRun = "34560340100";
export const isAdmittedRelease = (version: string): boolean => version === admittedReleaseVersion;
const installNotice = `This release candidate is not yet admitted. The v${releaseVersion} install command is unavailable until its immutable GitHub artifact passes exact release admission. The optional npm mirror has separate admission. The last admitted release is v${admittedReleaseVersion}; use its immutable release assets for the existing artifact. The v0.8.0 npm mirror is not admitted.`;
const daemonRolloutNotice = `Current daemon and hosted command-writer rollout remains blocked on capacity. Do not initialize, start, or autostart either the admitted v${admittedReleaseVersion} daemon or the v${releaseVersion} candidate until the hosted operator records protected two-pass zero-debt capacity evidence and its exact .activated readback receipt. Artifact availability and the live sync service do not clear this gate. After activation, complete the update runbook's daemon and target marker-2 proofs before globally enabling hosted writers.`;

/** The existing exact release evidence also belongs in the new status guide. */
export const releaseAdmissionNotice: ContentBlock = {
  kind: "notice",
  label: `Local v${releaseVersion} candidate; hosted sync live as an ${hostedBetaLabel}`,
  content: [
    text("The "),
    link(`v${admittedReleaseVersion} artifacts`, `https://github.com/hraness/oompa/releases/tag/v${admittedReleaseVersion}`),
    text(" passed immutable GitHub release admission in "),
    link(`release run ${admittedReleaseRun}`, `https://github.com/hraness/oompa/actions/runs/${admittedReleaseRun}`),
    text(`, attempt 1. Its optional npm mirror failed before publication and is not admitted. That evidence does not admit v${releaseVersion}. Use the predecessor's `),
    link("immutable release assets", links.admittedInstall),
    text(". The candidate command below remains unavailable until its own admission. The website and optional hosted sync are live; artifact admission does not authorize current-daemon startup or hosted command writers."),
  ],
};

/** Public runtime pins come from their authoritative source modules. */
export const publicPins = {
  bun: packageJson.engines.bun,
  claude: CLAUDE_PIN,
  codex: packageJson.dependencies["@openai/codex"],
} as const;

const shieldsLabel = (value: string): string =>
  encodeURIComponent(value.replaceAll("-", "--").replaceAll("_", "__"));
const staticBadge = (label: string, message: string, color: string): string =>
  `https://img.shields.io/badge/${shieldsLabel(label)}-${shieldsLabel(message)}-${color}`;

const badges: readonly Badge[] = [
  {
    alt: "npm version",
    href: "https://www.npmjs.com/package/@hraness/oompa",
    image: "https://img.shields.io/npm/v/%40hraness%2Fhra",
  },
  {
    alt: "provenance: sigstore",
    href: "https://www.npmjs.com/package/@hraness/oompa#provenance",
    image: staticBadge("provenance", "sigstore", "2e7d32"),
  },
  {
    alt: "CI",
    href: "https://github.com/hraness/oompa/actions/workflows/ci.yml",
    image: "https://img.shields.io/github/actions/workflow/status/hraness/oompa/ci.yml?branch=main&label=CI",
  },
  {
    alt: "license: MIT",
    href: "https://github.com/hraness/oompa/blob/main/LICENSE",
    image: "https://img.shields.io/npm/l/%40hraness%2Fhra",
  },
  {
    alt: `Bun ${publicPins.bun}`,
    href: "https://bun.sh",
    image: staticBadge("Bun", publicPins.bun, "14151a"),
  },
  {
    alt: `runtime: Codex ${publicPins.codex}`,
    href: `https://www.npmjs.com/package/@openai/codex/v/${publicPins.codex}`,
    image: staticBadge("runtime", `Codex ${publicPins.codex}`, "0b5fa5"),
  },
  {
    alt: `runtime: Claude Code ${publicPins.claude}`,
    href: "https://github.com/hraness/oompa/blob/main/docs/providers/claude.md",
    image: staticBadge("runtime", `Claude Code ${publicPins.claude}`, "6f42c1"),
  },
];

export const publicContent: PublicContent = {
  productName,
  tagline,
  providerRoadmap,
  releaseVersion,
  thesis: `${productName} brings your Codex and Claude Code sessions into one workspace. Follow the work in your browser, direct it from your terminal, and keep execution on your own machines.`,
  description: `A workspace for Codex and Claude Code, in your browser or terminal. Local CLI v${releaseVersion} is a release candidate; v${admittedReleaseVersion} remains admitted; daemon and hosted command-writer rollout remains blocked on capacity.`,
  daemonRolloutNotice,
  statusLine: `Status: public beta. ${isAdmittedRelease(releaseVersion) ? `Local CLI v${releaseVersion} is the fully admitted public artifact.` : `Local CLI v${releaseVersion} is a release candidate, not an admitted artifact; v${admittedReleaseVersion} remains the admitted canonical GitHub artifact.`} Codex runs on macOS and Linux, Claude Code on Linux; hosted sync is live as an ${hostedBetaLabel}. Current daemon and hosted command-writer rollout remains blocked on capacity.`,
  badges,
  maintainer: {
    name: "Hraness",
    url: links.hraness,
  },
  socialCard: {
    alt: `${productName} command-line card showing offline diagnostics and read-only status · v${releaseVersion} candidate · daemon rollout blocked on capacity · oompa.app`,
    height: 630,
    path: "/social-card.png",
    width: 1200,
  },
  siteUrl: "https://oompa.app",
  installCommand: betaInstallCommand,
  installNotice,
  initCommand: "oompa init --yes",
  doctorCommand: "oompa doctor --offline",
  endpoints: {
    betaTag: "beta-not-yet-live",
    githubRepository: "live",
    hostedSync: "live",
    website: "live",
  },
  hostedSignup,
  links,
  hero: {
    eyebrow: tagline,
    heading: "All your agents.\nOne place to keep up.",
    summary: "See what’s running, follow the conversation, and decide what happens next. Oompa brings your Codex and Claude Code sessions together in a web workspace, with a CLI for you and your agents.",
    example: "Your machines run the work. Oompa keeps you in the conversation.",
    boundary: `Public beta · Local v${releaseVersion} candidate · v${admittedReleaseVersion} artifacts admitted · current daemon and hosted command-writer rollout blocked on capacity · Codex on macOS and Linux · Claude Code on Linux`,
    primaryAction: {
      href: links.app,
      label: "Open Oompa",
    },
    secondaryAction: {
      href: "/docs/start/",
      label: "Get started",
    },
    pillars: [
      {
        label: "See the whole workspace",
        summary: "A grid of sessions shows what is running and what needs your attention. Read and reply inside each card.",
      },
      {
        label: "Pick up the next turn",
        summary: "Send a follow-up from the browser or terminal. The session runs on its machine, even after you close the tab.",
      },
      {
        label: "Keep accounts separate",
        summary: "Choose the provider profile for the work. Each managed profile has its own configuration; Oompa does not rotate accounts for you.",
      },
    ],
    proofLabel: "The same work, from your terminal.",
    steps: [
      {
        label: "Start",
        command: "oompa session start personal --provider codex --json",
        detail: "Create a Codex session under the account profile you choose.",
      },
      {
        label: "Inspect",
        command: "oompa session status <session-id> --json",
        detail: "Read the session and the cursor where its event stream continues.",
      },
      {
        label: "Switch",
        command: "oompa session switch <session-id> --provider claude --preset fable-max",
        detail: "Continue on your signed-in Claude Code profile. Oompa carries over the conversation it has retained and flags any missing history.",
      },
      {
        label: "Direct",
        command: "oompa session send <session-id> -- \"Review this project.\"",
        detail: "Send the next request to that session and provider.",
      },
    ],
    facts: [
      {
        label: "Accounts",
        value: "Isolated profiles",
        detail: "Codex uses its own CODEX_HOME per profile; Claude Code uses its own CLAUDE_CONFIG_DIR.",
      },
      {
        label: "Sessions",
        value: "Live, locally recorded",
        detail: "The daemon keeps sessions alive after a terminal exits and stores their provider-neutral transcript.",
      },
      {
        label: "Interfaces",
        value: "Web, shell, JSON",
        detail: "Follow sessions in the browser or use the CLI and its structured output.",
      },
      {
        label: "Sync",
        value: "Optional, encrypted",
        detail: "Everything local works without the cloud service.",
      },
    ],
  },
  trust: [
    {
      label: "Your accounts, your provider tools",
      detail: "Codex and Claude Code own their sign-in and execution. Oompa keeps managed profiles separate and does not broker model access.",
    },
    {
      label: "Local by default",
      detail: "The local daemon runs the sessions. The CLI works without an Oompa cloud identity; optional sync connects the web workspace and your other devices.",
    },
    {
      label: "Encrypted before it leaves the machine",
      detail: "Synced session content is encrypted for paired devices. The service still sees account and delivery metadata, described in the privacy policy.",
    },
    {
      label: "Analytics you can audit",
      detail: "oompa.app counts page views anonymously, without cookies, only on the production host, and honors Do Not Track. The privacy page lists every field.",
    },
  ],
  questions: [
    {
      question: "Does Oompa need an account?",
      answer: [text("The local CLI does not need an Oompa cloud identity. The web workspace does: sign in, pair your machine, and enroll the browser so it can decrypt your synced sessions. Your Codex and Claude Code accounts are separate.")],
    },
    {
      question: "Can I start using it now?",
      answer: [text(`The website, web app, and hosted sync are available in ${hostedBetaLabel}. The admitted v${admittedReleaseVersion} CLI has its own `), link("verified installation instructions", links.admittedInstall), text(" and "), link("immutable release assets", links.admittedInstall), text(`.${isAdmittedRelease(releaseVersion) ? "" : ` The v${releaseVersion} candidate is not yet admitted.`} Starting or upgrading a daemon and enabling hosted commands are paused until the capacity checks pass. `), link("Check the setup status", "/docs/status/"), text(" before initialization or daemon startup.")],
    },
    {
      question: "Does Oompa use my API keys or provider subscription?",
      answer: [text("Oompa does not broker model access. Each provider CLI keeps using its own account, billing, and terms. Oompa adds isolation, durability, and one command surface on top.")],
    },
    {
      question: "How do agents drive it?",
      answer: [text("The CLI exposes structured JSON and a cursor-based event stream. An agent can start a session, inspect its status, send a request, and follow progress. "), link("Read the command reference", "/docs/reference/"), text(" for the exact interface.")],
    },
    {
      question: "What if the terminal closes?",
      answer: [text("A session can outlive the terminal or browser tab because the local daemon owns its process. If the daemon itself stops, recovery depends on proving the old process is no longer writing. "), link("See session recovery", "/docs/sessions/"), text(" before restarting uncertain work.")],
    },
    {
      question: "Which platforms are supported?",
      answer: [text(`The CLI requires Bun ${publicPins.bun}. Codex execution supports macOS and Linux; Claude Code execution supports Linux. The web interface can follow paired machines from a browser.`)],
    },
  ],
  maker: {
    heading: "Built by Ben Guo",
    bio: [
      text("Oompa is built by Ben Guo, a musician and builder, formerly a founder and engineering leader at companies including Venmo and Stripe, who now builds his software factory from Puerto Rico. He runs more than a dozen Codex subscriptions at once and built Oompa to keep every session alive, isolated, and reachable from the same terminal."),
    ],
    links: [
      { href: links.hraness, label: "hraness.com" },
      { href: "https://x.com/hraness", label: "@hraness" },
      { href: links.github, label: "GitHub" },
    ],
  },
  introduction: [
    releaseAdmissionNotice,
    paragraph(
      text(`The v${releaseVersion} ${isAdmittedRelease(releaseVersion) ? "release" : "candidate"} retains the read-only exact Codex default-profile companion and browser-safe projection decoder admitted in v0.7.1. The decoder does not require CSP-blocked dynamic code generation. The default-profile display remains unavailable until a matching fresh companion is published by the intended daemon after the relevant rollout. This observation does not change Ultra defaults, admit models, select a route, or authorize a command.`),
    ),
    { kind: "notice", label: "Current daemon rollout blocked", content: [text(daemonRolloutNotice)] },
    paragraph(
      text("Oompa is one Bun CLI plus a local daemon. It isolates Codex and Claude Code profiles, gives both providers one compact session interface, and optionally syncs encrypted provider-neutral projections and commands across your enrolled machines."),
    ),
    paragraph(
      text("Oompa is short for harness: the control plane that keeps Codex and Claude Code sessions working together, and "),
      link("hraness.com", links.hraness),
      text(" explains the parent brand. The Hraness organization maintains Oompa and publishes it under the MIT license."),
    ),
    paragraph(
      link("GitHub", links.github),
      text(" · "),
      link("Documentation", links.documentation),
      text(" · "),
      link("Security", links.security),
      text(" · "),
      link("Privacy", links.privacy),
    ),
  ],
  sections: [
    {
      id: "install-and-update",
      heading: "Install and update",
      blocks: [
        { kind: "notice", label: "Candidate installation unavailable", content: [text(installNotice), text(" Read the "), link(`v${admittedReleaseVersion} installation notes`, links.admittedInstall), text(".")] },
        paragraph(
          text(`Oompa requires Bun 1.3.14 plus curl with HTTPS and TLS 1.2 support. The CLI and local daemon support macOS and Linux. Codex effects run on both platforms; Claude Code effects run on Linux only. Oompa refuses new Claude Code effects on macOS pending authenticated isolated-Keychain and detached-read acceptance. Native protected-input control loads only when a terminal prompt needs it and supports the standard macOS, glibc, and x64 or arm64 musl library names. ${isAdmittedRelease(releaseVersion) ? "Install the admitted release's reviewed immutable tag, then verify the binary before initialization:" : "Only after immutable GitHub release admission, install the candidate's reviewed immutable tag, then verify the binary before initialization:"}`),
        ),
        {
          kind: "commands",
          commands: [
            "bun --version",
            betaInstallCommand,
            "oompa --version",
            "oompa doctor --offline",
          ],
        },
        paragraph(
          text("The single install command removes ambient Bun, Node, and native-library injection variables before either download or Bun startup, disables Bun dotenv loading, and selects /dev/null as the only Bun configuration. Curl and the loader independently cap the streamed preflight at 512 KiB, and the loader refuses an overrun before transpilation or installation. It then verifies and executes the exact v0.8.1 preflight from Oompa's protected source tag and passes it the exact release archive URL. The preflight requires GitHub repository ID 1343008607, a published immutable v0.8.1 release, and one uploaded archive whose byte length and SHA-256 match GitHub's immutable release metadata. It creates a fresh random private staging root, downloads the archive into a private file there, and gives Bun only a verified in-memory snapshot of those exact bytes. The reviewed normalizer verifies the private archive again, derives its bounded package-file manifest, and compares every extracted Oompa package path and SHA-256 while measuring the completion receipt. Local archives and official archives use separate full-digest version namespaces, so a local package cannot populate or replace the official cache entry. Oompa then verifies the tagged preflight and normalizer, exact package identity, zero-lifecycle manifest, CLI SHA-256, and complete staged tree under protected descriptor and ACL custody. Bun 1.3.14 resolves the package's exact dependency versions from the configured package registry trust boundary with lifecycle scripts disabled; the release archive does not claim to contain that dependency closure. The detached staging worker and its Bun package-install child repeat the runtime neutralization while retaining the configured registry, proxy, and certificate trust inputs needed for dependency resolution. The prior verified command remains active throughout staging. Publication atomically replaces only the $BUN_INSTALL/bin/oompa symlink after every check succeeds and fsyncs its directory. If installation is interrupted, the next invocation of that exact release's installer recovers or removes only the proven private stage; another release's installer refuses the durable intent. The invoking shell, PATH-selected pinned Bun binary, configured package registry and transport trust, operating system, and same-UID account remain trust boundaries. Existing trustedDependencies remain unchanged."),
        ),
        { kind: "subheading", text: "Update runbook" },
        paragraph(
          text("Use this sequence to replace an installed release. Resolve every uncertain local mutation that depends on old alias or prepared authority before starting the current daemon, and preserve remote-command evidence for the fail-closed reconciliation below. Replace the tagged preflight URL, release archive URL, expected preflight digest, and expected version together with one exact reviewed immutable tag. Never install a moving branch on a release machine, and never run an older daemon against this state root after the current daemon has started."),
        ),
        orderedList(
          {
            content: [
              text("Settle any durable installer intent left by an interrupted installation. An installer refuses "),
              code("$BUN_INSTALL/install/oompa/install-intent.json"),
              text(" when the intent is invalid or belongs to another release. Do not edit or delete that file or its staging or version directories. Rerun the exact immutable install command from the originating release's trusted README or release notes and require the exact "),
              code("hra-install-safe"),
              text(" success output. If that installer refuses the intent, stop installation and use bounded read-only diagnosis while preserving the intent and its directories; after exact recovery succeeds, restart this runbook with the current release. Establish the originating tag independently from trusted release evidence; never execute a URL or command copied only from the intent. An uncertain tag blocks execution, not diagnosis. Ask the owner only when the evidence cannot resolve a required decision or authority is missing. This recovers only local installer state. It is not authorization to retry, rerun, or mutate that release's GitHub Actions workflow, tag, GitHub Release, or npm publication."),
            ],
          },
          {
            content: [
              text("Resolve keyed local mutations under the installed release. For a Codex High or Ultra "),
              code("session start"),
              text(", or a source-sensitive provider switch that explicitly or implicitly selects either alias, replay the exact idempotency key using the originating release's own syntax and source evidence. Resolve an affected Work mutation by replaying its exact request document. A v42 attachment-bearing send or steer should likewise be replayed under v42 before updating whenever that release remains usable; retain the exact original message, attachment path and basename, and explicit key if migration has already occurred and the narrow v43 bridge below is required. Continue only when exact replay under the originating release, or that release's documented kind-specific recovery, reaches a terminal settlement. Otherwise the update remains blocked. If that release has no explicit source-contract flag, use only its exact syntax; do not invent an unsupported option or infer an old alias meaning from the new release."),
            ],
          },
          {
            content: [
              text("Resolve any uncertain "),
              code("session preset"),
              text(" under the installed release. This command has no idempotency key, so repeat it if necessary and inspect the session before updating."),
            ],
          },
          {
            content: [
              text("Block the update on any remaining prepared or indeterminate local mutation. Oompa exposes no general command to cancel a prepared session start or provider switch, and "),
              code("session abandon"),
              text(" applies only to an existing recovery-required session. Retain the originating release and state root until exact replay or its documented recovery reaches a terminal settlement. Do not generate a fresh key or edit SQLite as a workaround."),
            ],
          },
          {
            content: [
              text("Reconcile every uncertain CLI session-command enqueue by repeating the exact remote request with its exact idempotency key. Let Oompa's durable local outbox reconcile the response, retain every returned session-command ID, and inspect each one with "),
              code("oompa remote command <uuidv7>"),
              text(". For a browser or device command, retain the current tab's returned command handle and public ID, then inspect it through the app or the corresponding hosted query. The app does not expose its internal idempotency key and must not synthesize a resend. Never edit or delete the local command journal, local outbox, tab state, or hosted row to force progress."),
            ],
          },
          {
            content: [text("Stop the daemon and prove that it released authority:")],
            commands: [
              "oompa daemon stop --json",
              "oompa daemon status --json",
            ],
            afterCommands: [
              text("Require the stop command itself to exit zero; its recovery path is the authority-release proof. Treat a status response containing "),
              code("data.running: false"),
              text(" only as a secondary no-listener confirmation. Status alone does not prove authority release. Stop on any stop or recovery error."),
            ],
          },
          {
            content: [
              text(isAdmittedRelease(releaseVersion)
                ? `Install the admitted v${releaseVersion} exact release, then verify the installed version and offline health:`
                : `Only after immutable GitHub release admission for v${releaseVersion}, install its exact release and verify the installed version and offline health. Until then, use the admitted v${admittedReleaseVersion} installation notes instead:`),
            ],
            commands: [
              betaInstallCommand,
              "oompa --version",
              "oompa doctor --offline",
            ],
            afterCommands: [
              text("Require the exact expected version. Before the first current-daemon start, doctor must either succeed or report only the exact pending state-schema migration that names the old and current schema versions. Any other diagnostic stops the update."),
            ],
          },
          {
            content: [
              text("Before starting any current daemon, require the hosted operator to deploy the additive candidate from this release's exact reviewed source, then run the source- and runtime-bound command-capacity status and repair workflow in "),
              code("docs/hosted-sync.md"),
              text(". Accept only its protected two-pass zero-debt capacity evidence together with the exact .activated receipt produced after hosted activation and readback for that candidate and numeric target. The capacity evidence alone is not readiness. The hosted activation tuple opens the exact-runtime gate; the later local .activated publication proves the readback and is required before declaring writers ready, but does not itself open that gate. A hard-full legacy owner, partial capacity set, unreserved command debt, unsafe cleanup shape, interrupted intent, candidate swap, concurrent debt, missing activation, or failed readback blocks the update. The Vercel app may auto-deploy earlier, but that UI is not command readiness or effect authority and its commands should receive expected pre-insertion refusals while the runtime gate is closed."),
            ],
          },
          {
            content: [
              text("Start the current daemon. This is the no-downgrade boundary: after this command begins, never launch an older daemon against the same state root. Prove post-migration health before syncing, then inspect every retained CLI session-command ID:"),
            ],
            commands: [
              "oompa daemon start",
              "oompa doctor --offline",
              "oompa sync now --json",
              "oompa sync status",
              "oompa remote command <uuidv7>",
            ],
            afterCommands: [
              text("Require the post-start doctor command to succeed before sync. If migration retained a v42 send or steer that stopped after preparation but before its attachment manifest or provider effect, replay it now with the same command kind, session, message, original attachment path and basename, and explicit idempotency key. The current CLI admits an earlier-policy-only basename only on this keyed local replay, and the daemon requires the original durable request digest before resolving the blob or contacting a provider. Any missing or changed field fails without a new mutation; fresh sends, steers, queued messages, and hosted payloads remain on the current name rule. For every intended target, require the sync-now response to contain "),
              code("data.online: true"),
              text(" and "),
              code("data.errorCount: 0"),
              text(", and "),
              code("data.commandRequestVersion: 2"),
              text("; a pending device identity or failed registry publication leaves the last field null, and the command exits zero even when its bounded diagnostics report a registry-publication failure. There is no per-target writer switch. Finish all intended target proofs before deploying marker-emitting writer clients globally, or accept and monitor the expected pre-insertion refusals on ungated or mismatched targets. Old clients and targets whose markers are both absent remain compatible. Sync status reports projection recovery, not the command outbox. Use retained CLI session-command IDs for remote-command inspection; inspect browser and device commands through the app or corresponding hosted query."),
            ],
          },
          {
            content: [
              text("Classify legacy remote commitments from both the local journal and hosted row before retrying. The current daemon never executes a legacy request commitment. An already-hosted terminal row takes precedence: it confirms the hosted result and permits local retirement without replaying a local outcome. Otherwise, if the hosted row remains nonterminal and either side records "),
              code("effect_started"),
              text(", close it result-less as "),
              code("ambiguous"),
              text(". A legacy local terminal outcome over any hosted nonterminal row is unauthenticated evidence: discard that outcome and close result-less as "),
              code("LOCAL_EFFECT_RECOVERY_REQUIRED"),
              text(" ambiguous. A fresh or local-prepared legacy request over hosted "),
              code("pending"),
              text(" or "),
              code("prepared"),
              text(" row closes as "),
              code("failed"),
              text(" with "),
              code("LEGACY_REQUEST_COMMITMENT_BEFORE_EFFECT"),
              text(". Retry only a failed-before-effect request, only after its initiating client is also current, and use a fresh idempotency key. Retain the new command ID. Never automatically retry an ambiguous command. Each daemon privately publishes its command-request version before processing commands. A fresh request is inserted only when its marker exactly matches the target's last stored registry marker and the hosted runtime's capacity activation tuple exactly matches its compiled release attestation. A marker or activation mismatch is rejected before the command, quota charge, or security event is written. A stale matching target marker can exist during an upgrade or downgrade window, but a candidate redeploy invalidates the hosted activation, and the executor checks stop a mismatched binary before prepare or provider effect while recovery paths classify retained rows conservatively. Exact same-key replay remains available across a later target or runtime change, but changing versions under one key conflicts. A registry-publication failure skips both command queues for that cycle, and every marker-2 command also requires current target and hosted activation markers before a new prepare or effect start. The hosted tuple, not the local receipt publication, opens the runtime gate. Accept the protected capacity evidence and its .activated readback receipt from the prerequisite above before declaring writers ready. Require one "),
              code("oompa sync now --json"),
              text(" result with "),
              code("data.online: true"),
              text(" and "),
              code("data.errorCount: 0"),
              text(", and "),
              code("data.commandRequestVersion: 2"),
              text(", before treating marker-emitting writers as globally available. The Vercel app can auto-deploy from main earlier; that UI is not readiness, and its commands should receive expected pre-insertion refusals until capacity activation and target-marker proof exist. No all-daemons pause or account-wide legacy drain is required."),
            ],
          },
        ),
        {
          kind: "notice",
          label: "v0.5 upgrade quarantine",
          content: [
            text("The first daemon start after a v0.5-to-v0.6 upgrade migrates local state but never infers provider-account authority that v0.5 did not record immutably. Every affected nonterminal session enters recovery_required: pending or prepared effects are cancelled, begun effects remain uncertain, scheduled work pauses, pending interactions expire while begun responses become resolution-unknown, and associated Work execution is retired or fenced. Provider threads and local records are not deleted. This is not a generic automatic-recovery state. Inspect the session first; use "),
            code("oompa session abandon <session>"),
            text(" only when you accept terminalizing Oompa's local session with provider state still unknown."),
          ],
        },
        { kind: "subheading", text: "Optional full local-data removal" },
        paragraph(
          text("Full local-data removal is a separate destructive operation. While Oompa remains installed, complete "),
          code("oompa auth delete --acknowledge-erasure"),
          text(" if "),
          code("oompa auth status"),
          text(" says you are signed in, then wait for "),
          code("oompa auth status"),
          text(" to report terminal deletion. Run "),
          code("oompa account list"),
          text(", then run "),
          code("oompa account logout <profile>"),
          text(" for every Codex profile. Oompa does not sign Claude Code out; use Claude Code's own authentication flow inside every isolated "),
          code("CLAUDE_CONFIG_DIR"),
          text(" whose credential should be removed. Stop the daemon and require "),
          code("oompa daemon stop --json"),
          text(" itself to exit zero as the authority-release proof. A successful "),
          code("oompa daemon status --json"),
          text(" result whose "),
          code("data.running"),
          text(" is "),
          code("false"),
          text(" is only an optional no-listener confirmation before touching local data."),
        ),
        {
          kind: "commands",
          commands: [
            "oompa auth delete --acknowledge-erasure",
            "oompa auth status",
            "oompa account list",
            "oompa account logout <profile>",
            "oompa daemon stop --json",
            "oompa daemon status --json",
          ],
        },
        {
          kind: "notice",
          label: "Permanent local-data loss",
          content: [
            text("Oompa deliberately has no recursive local-delete command. The exact state directory is "),
            code("$HOME/Library/Application Support/HRA Control Plane v1"),
            text(" on macOS and "),
            code("$HOME/.local/state/hra-control-plane-v1"),
            text(" on Linux. After every prerequisite above, a human who explicitly accepts permanent loss of all local provider profiles, Codex credential stores, Claude Code configuration directories, sessions, ledgers, encryption keys, device credentials, and recovery evidence may move only the exact platform directory to Trash. Claude Code may also own credentials outside that directory, including provider-managed system credential storage; sign out through Claude Code before deletion. Do not move or remove the state directory's parent. Inspect the trashed directory before emptying Trash."),
          ],
        },
        paragraph(
          text("An agent must resolve the canonical exact state-directory path, present that path and the permanent-loss consequences to the user, and obtain explicit destructive approval before moving or removing it. An install, update, or daemon-stop request does not authorize local-data removal."),
        ),
      ],
    },
    {
      id: "first-account",
      heading: "First account",
      blocks: [
        { kind: "notice", label: "Conditional walkthrough", content: [text(daemonRolloutNotice)] },
        {
          kind: "commands",
          commands: [
            "oompa account add personal",
            "oompa account login personal --provider codex --device-code",
            "oompa account usage personal --refresh",
            "oompa account usage-history personal --limit 50 --json",
          ],
        },
        paragraph(
          text("Account login is always a dedicated one-shot invocation, including while the persistent shell is running. For Codex, use "),
          code("oompa account login personal --provider codex --device-code"),
          text(" in a foreground TTY for app-server's device-code path. That terminal displays the code and verification URL directly. An opted-in registered machine can also receive a versioned web request that always selects device-code mode; Oompa accepts only the pinned Codex device URL and a separate closed code, encrypts them to the account key, and lets only the requesting browser read the handoff once before its five-minute hosted expiry. Oompa keeps the resulting provider state inside that profile's isolated "),
          code("CODEX_HOME"),
          text(" without copying "),
          code("auth.json"),
          text("."),
        ),
        paragraph(
          text("On Linux, "),
          code("oompa account login personal --provider claude"),
          text(" launches a realpath-resolved Claude Code executable only after its exact self-reported version matches Oompa's pin, in the foreground inside that profile's isolated "),
          code("CLAUDE_CONFIG_DIR"),
          text(". Claude owns its prompts and browser handoff. Oompa gives it the terminal, joins the exact child, and reports only whether Claude says it is signed in; Oompa never opens or copies a Claude credential. Claude exposes no Oompa device-code, handoff-file, or web-linking protocol. New Claude effects are refused on macOS pending authenticated isolated-Keychain and detached-read acceptance."),
        ),
        paragraph(
          text("For a Codex login, JSON and noninteractive callers must create an empty mode-0600 file under a canonical current-user-owned mode-0700 directory, then pass its absolute canonical path:"),
        ),
        {
          kind: "commands",
          commands: [
            "oompa account login personal --device-code --handoff-file /absolute/private/login.json --json",
          ],
        },
        paragraph(
          text("Oompa opens and holds the parent and file, resolves the account selector to one exact local account ID, and dispatches login only for that authority. It validates the returned account, state, cancellation command, URL, and device-code shape, writes one versioned login document through the held descriptor, verifies it with fsync and readback, and closes both descriptors before returning only the path and cleanup disposition on stdout. The caller reads the file through its protected boundary and removes it after login. A same-key replay never claims or rewrites a handoff. While login is pending it reports that one-time instructions are unavailable; after completion or cancellation it reports the terminal account state."),
        ),
        paragraph(
          text("If the first pending-login handoff is lost or the daemon restarts before completion, "),
          code("oompa account show personal --provider codex"),
          text(" reports the pending attempt. Then run "),
          code("oompa account login-cancel personal --provider codex"),
          text(". A caller that retained the idempotency key may retry it without redispatching. A still-pending local replay cannot recover the one-time code or URL; a completed or canceled replay returns terminal signed-in or signed-out evidence instead of stale pending state. Oompa cancels only that profile's exact current-generation provider login before allowing a fresh login. Verification URLs and user codes never enter local durable Oompa state, logs, or ordinary command output. A protected handoff file may retain them for its local caller; the web path instead retains only an account-key-encrypted, one-read hosted result until consumption or five-minute expiry."),
        ),
        paragraph(
          text("If a Claude foreground parent or daemon fails after launch, "),
          code("oompa account show personal --provider claude"),
          text(" retains the one-child fence even if Claude reports signed in. After confirming that original child has exited, use the exact attempt, generation, and idempotency key in the reported acknowledged "),
          code("oompa account login-cancel"),
          text(" command to release only the local fence. That recovery does not stop Claude or read, change, or delete a credential."),
        ),
        paragraph(
          code("oompa account list --provider codex"),
          text(" or "),
          code("oompa account list --provider claude --json"),
          text(" reads cached provider order, default marker, readiness and observation times. It does not refresh providers or change account selection. Unknown observation times stay unknown; cached readiness is not current sign-in proof or quota freshness. The read verifies at most 10,000 live profiles and returns at most 10,000 accounts within a separate 3 MiB JSON limit, refusing oversized or inconsistent results without truncation. Unqualified "),
          code("oompa account list"),
          text(" keeps the existing profile listing."),
        ),
        paragraph(
          code("oompa account usage"),
          text(" is Codex-only and keeps the latest snapshot and 1-, 5-, and 15-minute observed token velocity. "),
          code("oompa account usage-history <profile>"),
          text(" reads the retained 24-hour local ledger in durable source order. Use UTC RFC3339 "),
          code("--from"),
          text(" and "),
          code("--through"),
          text(" bounds plus the returned opaque cursor for later pages; a cursor freezes that account and range and expires after five minutes. History rows contain only derived token observations or closed poll-failure codes; raw provider payloads are never returned."),
        ),
        paragraph(
          code("oompa usage auto status [codex|claude]"),
          text(" reads local automatic-policy configuration and its revision. Without a provider, "),
          code("on|off"),
          text(" changes the inherited default, not a global kill switch. A provider's explicit "),
          code("on"),
          text(" override remains enabled when that default is off; "),
          code("inherit <codex|claude>"),
          text(" restores inheritance. Every change requires "),
          code("--revision <n>"),
          text(" from status and a caller-owned "),
          code("--idempotency-key <uuid>"),
          text(". After a lost response, replay the exact command with the same key and revision. Its saved receipt is not the current configuration; read status again for that. These controls do not refresh providers, move accounts or sessions, or enable unavailable runtime capabilities. Devin has no automatic usage policy."),
        ),
        paragraph(
          text("When effective Codex automatic policy is enabled, Oompa automatically spends one available earned Codex rate-limit reset when a fresh read shows the exact seven-day Codex window at 99 percent used or higher. It records a private idempotency key before dispatch, retries only that key after an uncertain response, and rereads limits after every closed outcome. Disabling suppresses new automatic reset dispatches, including retries, while retaining uncertain attempts under their original keys. A later disable does not cancel an already admitted operation or skip settlement and rereading after a closed outcome. A successful redemption is latched to that weekly window, so a stale usage snapshot cannot spend another credit. Rate-limit notifications wake a coalesced authoritative read; the staggered 50-to-70-second poll remains the fallback. "),
          code("oompa account usage"),
          text(" reports the most recent local reset attempt with its source weekly-window boundary and suppresses a prior identity's snapshot after an account change. Credit IDs, descriptions, private keys, and account fingerprints never enter that reset status or its cloud projection."),
        ),
        paragraph(
          text("Automatic account movement is not exposed yet. The adopted provider-usage boundary permits only a managed Codex session to follow a durable account decision after reset handling and fresh exact source and target reads. Explicit sessions and work tasks stay pinned to the account you selected. Claude and Devin accounts never rotate automatically, and Oompa never replays a failed or ambiguous turn under another account."),
        ),
        paragraph(
          text("Oompa cloud identity is separate from every Codex or Claude Code account. Use the email-code flow below only after a hosted or self-managed Convex deployment has been configured."),
        ),
      ],
    },
    {
      id: "first-session",
      heading: "First session",
      blocks: [
        { kind: "notice", label: "Conditional walkthrough", content: [text(daemonRolloutNotice)] },
        paragraph(
          text("Only after the rollout prerequisite is satisfied, complete initialization and the first provider login before this walkthrough. Account login remains a dedicated one-shot command, and the session-start command returns the new session ID."),
        ),
        { kind: "subheading", text: "Human terminal" },
        paragraph(
          text("Create an idle session, open the persistent shell, select the account and exact returned session ID, then type a request as an ordinary line. Oompa sends that line to the selected session and shows safe live updates. "),
          code("/exit"),
          text(" leaves the daemon running."),
        ),
        {
          kind: "commands",
          commands: [
            "oompa session start personal --provider codex",
            "oompa",
            "/account personal",
            "/session <session-id>",
            "Review this project and summarize its current state.",
          ],
        },
        { kind: "subheading", text: "Agent caller" },
        paragraph(
          text("Read "),
          code("data.session.id"),
          text(" from the start response. Before sending, call status and read "),
          code("data.eventStream.cursor"),
          text(" from its version-2 result. Start watch from that exact cursor so the atomic local snapshot and subsequent event stream are contiguous. Keep watch as a long-running subprocess, consume its two output streams independently, and use the exact ID instead of a mutable title in automation."),
        ),
        {
          kind: "commands",
          commands: [
            "oompa session start personal --provider codex --json",
            "oompa session status <session-id> --json",
            "oompa session send <session-id> -- \"Review this project and summarize its current state.\"",
            "oompa session watch <session-id> --cursor <status-cursor> --jsonl",
            "oompa session interactions <session-id> --pending --json",
          ],
        },
        paragraph(
          text("If the event stream reports a blocking interaction, read its exact ID and revision, inspect the live authority through the protected path, and resolve only the interaction kind you received. Keep following while a separate one-shot invocation handles the approval, question, permission grant, or supported MCP form. The protected interaction commands and input documents are defined below."),
        ),
        paragraph(
          text("Devin support has been removed because its supported CLI integration cannot provide verified remaining account quota and reset times. Existing Devin history is read-only and provider-owned credentials are preserved. "),
          link("Retired-provider compatibility and local login-fence cleanup", "https://github.com/hraness/oompa/blob/main/docs/providers/devin.md"),
          text(" remain documented; no new Devin login or session can start."),
        ),
        { kind: "subheading", text: "Claude Code and provider switching" },
        paragraph(
          text("Start directly with Claude Code by selecting its provider and reviewed preset, or move an idle session between providers. A switch seeds a fresh provider-native runtime from the latest retained tail of Oompa's provider-neutral conversation record; it does not move a provider-native thread. From the point the v0.6 daemon begins recording a session, that record covers accepted direct, queued, Work and scheduled automation, autorespond, and provider-switch handoff messages with actor provenance. It does not backfill provider history from before a personal-home session was admitted or user turns from before a v0.5 installation was upgraded, and those origin gaps do not set the current retention-gap field. Attachments are represented only by byte-free manifests containing bounded names, media types, sizes, and digests. Retention is capped at 50,000 events, 64 MiB, and seven days; when pruning has occurred, switch seeds and exports state the retention reason and leave the unavailable older count unknown. A switch refuses an active turn, an unsettled provider effect, an unsigned target profile, or a preset that belongs to another provider. If a Claude controller is no longer available, Oompa can recover the exact conversation with "),
          code("--resume"),
          text(" only after prior-process exit or an already-completed exact process release is proven. Ambiguous custody stays fenced in recovery without launching another process."),
        ),
        {
          kind: "commands",
          commands: [
            "oompa session start personal --provider claude --preset fable-max --json",
            "oompa session switch <session-id> --provider claude --preset fable-max",
            "oompa session export <session-id> --format json",
          ],
        },
        { kind: "subheading", text: "Scheduled work in the same conversation" },
        paragraph(
          text("Attach a recurring whole-minute interval to an existing session with "),
          code("oompa session task"),
          text(". Each run returns to that exact Oompa conversation. A task cannot independently retarget its account, provider, project, model, or execution environment; later explicit changes to the session apply to future runs. Missed intervals coalesce into one queued turn. Use the returned task ID and revision for later edits or deletion; Oompa never creates a replacement provider conversation or writes a provider's private automation registry."),
        ),
        {
          kind: "commands",
          commands: [
            "oompa session task create <session-id> --name daily-review --every-minutes 1440 -- \"Review the release queue.\"",
            "oompa session task list <session-id>",
            "oompa session task show <session-id> <task-id>",
            "oompa session task edit <session-id> <task-id> --revision <revision> --pause",
            "oompa session task edit <session-id> <task-id> --revision <revision> --resume",
            "oompa session task delete <session-id> <task-id> --revision <revision>",
          ],
        },
      ],
    },
    {
      id: "agent-work-protocol",
      heading: "Agent work protocol",
      blocks: [
        {
          kind: "notice",
          label: "Local release boundary",
          content: [
            text("These commands are part of the "),
            code(`v${admittedReleaseVersion}`),
            ...(isAdmittedRelease(releaseVersion) ? [
              text(" admitted local CLI release. Its immutable GitHub artifact passed admission; the optional npm mirror is not admitted. Hosted sync is not required for this local protocol; the current-daemon rollout prerequisite still applies before startup."),
            ] : [
              text(" admitted local CLI release and are retained in the "),
              code(`v${releaseVersion}`),
              text(" candidate. The predecessor's immutable GitHub artifact passed admission; its optional npm mirror is not admitted and the candidate requires its own admission. Hosted sync is not required for this local protocol; the current-daemon rollout prerequisite still applies before startup."),
            ]),
          ],
        },
        paragraph(
          text("The versioned source contract defines a narrow local coordination kernel for agents operating several already-existing provider sessions. It records six bounded objects: work, tasks, attempts, submissions, reviews, and signals. Codex and Claude Code still own their provider-native execution, turns, tools, context, and approvals. Oompa does not add a second model loop or a generic executable workflow engine."),
        ),
        {
          kind: "commands",
          commands: [
            "oompa work protocol [--operation <kind>|--type <name>|--topic <topic>]",
            "oompa work apply --input-stdin",
            "oompa work snapshot <work> [--actor <session>]",
            "oompa work task <task> [--history-limit <1..50>] [--history-cursor <cursor>]",
            "oompa work poll <work> [--actor <session>] [--cursor <event-cursor>] [--action-cursor <action-cursor>] [--limit <1..50>] [--wait-ms <0..30000>]",
            "oompa work events <work> [--cursor <cursor>] [--limit <1..200>] [--wait-ms <0..30000>]",
            "oompa work watch <work> [--cursor <cursor>]",
          ],
        },
        paragraph(
          text("The seven commands are agent-only. Non-streaming commands emit compact JSON without requiring "),
          code("--json"),
          text(". "),
          code("work watch"),
          text(" emits resumable JSON Lines. "),
          code("work apply"),
          text(" is the only mutation entry point. It reads one strict version 1 or version 2 request from nonterminal standard input or an explicit file descriptor. Both versions contain "),
          code("{protocol,version,requestId,operation}"),
          text(", and the nested operation carries its UUIDv7 "),
          code("idempotencyKey"),
          text(". A version 2 "),
          code("work.create"),
          text(" that declares a High or Ultra route, or "),
          code("task.addBatch"),
          text(" that adds a High or Ultra task, also carries the caller-authored top-level "),
          code("presetContract"),
          text("; version 2 forbids that field on stable operations. Success and failure echo the admitted request ID and version, and work capabilities are never accepted as argv fields. The request version and any authored preset contract are part of changed-intent detection. Same-key replay of the exact request preserves the durable decision, stable identities, and capabilities without adding a mutation, event, or revision, while mutable public records and the work revision are reprojected from current state. It is not a byte-identical response promise. A retained release tombstone is the exact stored-result exception. "),
          code("work protocol"),
          text(" is queryable by operation, type, or topic. It returns both accepted apply envelopes, exact field contracts, value syntax, capability semantics, operation kinds, hard bounds, and the closed recovery and process-exit guidance for failures."),
        ),
        paragraph(
          text("Each task carries an exact account ID, project ID, preset, and Fast setting. Oompa never chooses another subscription from quota, availability, usage, or incidental ordering. A provider limit blocks or fails that attempt. It does not rotate the task to another account. Explicit tasks on separate accounts may run in parallel."),
        ),
        paragraph(
          text("Each Work also freezes the meaning of its High and Ultra routes when it is created. A fresh affected version 2 request must name the current contract 2 Astra meaning. A fresh affected version 1 request is refused because that format does not identify whether its author meant Sol or Astra; stable version 1 requests remain admissible. An existing contract 1 Work whose coordinator and participating session authorities remain supported keeps Sol for already-declared tasks and remains readable, claimable, reviewable, and settleable. A Work associated with a retired Devin session remains readable but is fenced from mutation and execution. Current tooling does not append a new High or Ultra task to a contract 1 Work because the alias now means Astra; create a new Work for a new Astra task graph. Low has the same exact Luna Max meaning under both contracts and remains compatible. Exact same-key replay of an already-applied version 1 or version 2 mutation returns its historical result without adding a task or provider effect. Reusing that key with another version or contract is a conflict, not a request to reinterpret the historical operation."),
        ),
        paragraph(
          text("Readiness is derived from the open work state, time bounds, accepted dependency submissions, and absence of a live or ambiguous attempt. A final assistant message is not completion. The worker submits a bounded structured result and evidence; declared independent reviews and Oompa-owned completion gates must accept the exact submission revision."),
        ),
        paragraph(
          text("Dispatch binds one already-existing exact actor session and always starts a new turn. Oompa's task graph is the durable task queue; queue and steer are reserved for coordination signals. Oompa commits the claim, monotonic fence, route, session binding, request digest, and prepared effect before the provider call. If the provider effect may have started but cannot be proved, the attempt becomes recovery-required. Oompa does not redispatch, steal, or reroute it speculatively."),
        ),
        paragraph(
          text("Coordinator, member, and exact-attempt capabilities scope every mutation and never appear in snapshots, polls, or events. Poll action arrays have a separate signed, actor-bound continuation with a frozen projection time; a changed work stream invalidates it instead of returning stale authority."),
        ),
        paragraph(
          text("Signal delivery and recipient acknowledgement are separate facts. "),
          code("deliveryState"),
          text(" reports pending, accepted, failed, or unknown provider delivery. "),
          code("acknowledgedAt"),
          text(" records the recipient acknowledgement independently, including when delivery remains pending or unknown."),
        ),
        paragraph(
          text("Snapshots expose bounded recent work-level signals and an omitted count. With no history option, "),
          code("work task"),
          text(" returns task detail with active and latest attempt lineage, the latest full attempt report, the latest submission and its ordered reviews, and bounded recent task signals. Either "),
          code("--history-limit"),
          text(" or "),
          code("--history-cursor"),
          text(" selects a separate task-history page over the task's attempts, reports, submissions, reviews, and task signals; a cursor-only continuation defaults to 20 items. Each complete compact JSON response for snapshot, task detail, and task history, including its envelope and terminating newline, is capped at 512 KiB. Only recent or historical arrays are trimmed, and omitted or remaining counts and continuations make every reduction explicit."),
        ),
        paragraph(
          text("A signed task-history continuation freezes the work stream sequence and epoch, task membership high-water ordinal, task revision, projection time, and next offset. Append-only bounded public projection versions reconstruct every returned record as of that cut. Later mutations and later history memberships are excluded from every continued page, so pagination is coherent even while agents keep working."),
        ),
        paragraph(
          text("Each JSONL gap, event, or checkpoint frame, including its terminating newline and terminal-safe escaping, is capped at 512 KiB. A terminal stream failure is one compact JSON document on stderr capped at 64 KiB. The queryable protocol advertises both wire limits."),
        ),
        paragraph(
          text("Accepted submissions, reviews, evidence references, receipts, and completed tasks are durable prefixes. Later failure or cancellation preserves them. No SQLite writer transaction spans provider reasoning, provider I/O, artifact hashing, or Git inspection. This applies the durable-prefix lesson in "),
          link("Agent Swarms are a Distributed Systems Problem", "https://www.trychroma.com/engineering/transactions"),
          text(" without adopting generic page locking, wound-wait, or speculative replay."),
        ),
        paragraph(
          code("task.claimNext"),
          text(" records an exact idempotent empty result when no task is ready without appending an event or advancing the work revision. "),
          code("work.release"),
          text(" is the other stream-neutral mutation. It requires terminal work, the exact coordinator capability and revision, and "),
          code("acknowledgeDataLoss: true"),
          text(". Only an unresolved attempt dispatch blocks release. An ambiguous signal delivery may be discarded under that acknowledgement and is counted in the tombstone."),
        ),
        paragraph(
          text("A successful release atomically deletes the work graph and durable history, including the task-history membership index and projection versions, then retains a separately bounded tombstone with the final stream head, terminal and release request digests, discarded-record counts for both history tables and the rest of the graph, and a digest of that release boundary. While the tombstone remains, only the same release idempotency key and canonical request digest have an exact replay result. Replay guarantees for every earlier operation have ended. Tombstones have count, byte, and maximum-age bounds, so their retention timestamp is an upper bound rather than a promise."),
        ),
        paragraph(
          text("This release is an explicit logical destructive purge, not a forensic-erasure promise. SQLite secure deletion is defense in depth, but the command does not promise immediate physical sanitization of prior database pages, WAL frames, backups, snapshots, or storage media."),
        ),
        paragraph(
          text("Local SQLite is the only execution authority for work admission, claims, fences, dispatch receipts, submissions, reviews, signals, and the work-scoped event cursor. The initial work protocol has no cloud execution or cross-device takeover path. Turso is deferred behind a repository boundary and cannot be added as a second authority beside SQLite or encrypted Convex projections."),
        ),
      ],
    },
    {
      id: "cloud-sign-in-and-device-pairing",
      heading: "Cloud sign-in and device pairing",
      blocks: [
        { kind: "notice", label: "Conditional walkthrough", content: [text(daemonRolloutNotice)] },
        paragraph(
          text(`The hosted endpoint is live as an ${hostedBetaLabel}. An unset `),
          code("HRA_CONVEX_URL"),
          text(" selects Oompa's hosted deployment. Set it to an explicit empty value before the first daemon starts to disable cloud transport. A nonempty HTTPS value selects a self-managed Convex deployment. The first valid selection permanently binds that local state root; a later mismatch fails closed instead of moving credentials or recovery state. After deliberately disabling a bound state root, "),
          code("oompa sync status"),
          text(" and "),
          code("oompa doctor"),
          text(" report its exact restart prerequisite: unset "),
          code("HRA_CONVEX_URL"),
          text(" for the hosted deployment, or restore the bound URL for a self-managed deployment. Oompa accepts cloud credentials only as protected JSON on standard input or a nonterminal file descriptor. It rejects email addresses, identity invites, and verification codes on the command line:"),
        ),
        {
          kind: "commands",
          commands: [
            "oompa auth login --input-stdin",
            "oompa auth login --input-fd <fd>",
            "oompa device pair",
            "oompa device key-loss --acknowledge-no-key-holders",
            "oompa sync status",
          ],
        },
        paragraph(
          text("Each login reads exactly one JSON document. Request a code for an existing identity with "),
          code('{"email":"you@example.com"}'),
          text(", create a new identity with "),
          code('{"email":"you@example.com","invite":"<identity-invite>"}'),
          text(", or verify a requested code with "),
          code('{"email":"you@example.com","code":"12345678"}'),
          text(". No other keys or combinations are accepted. A TTY prompt hides the document; agents should pass a private descriptor with "),
          code("--input-fd <fd>"),
          text(". The document is never an argument."),
        ),
        paragraph(
          text("The CLI stores Oompa's revocable device credential, workspace encryption key, and local signing authority as immutable generations below its private state root. Custody directories are current-user-owned mode-0700 directories, values are single-link mode-0600 files, and reads use bounded no-follow descriptors. The detached Bun daemon never opens a Keychain prompt. Oompa forces both pinned Codex credential stores to file mode and verifies their effective settings. Managed Codex accounts keep credentials in each profile's isolated "),
          code("CODEX_HOME"),
          text(". Claude Code receives that profile's isolated "),
          code("CLAUDE_CONFIG_DIR"),
          text("; Oompa treats the whole directory as Claude's authentication boundary and never reads, copies, or forwards its credentials. Explicitly adopted Codex and Claude Code personal sessions use credentials already owned by the user's personal provider home without copying or parsing them. Provider-managed credential storage remains owned by the provider runtime."),
        ),
        paragraph(
          text("After successful email verification, the daemon automatically registers the current installation before it reads cloud data. The first registered device becomes active and creates the client-side encryption key. A later verified installation is registered as pending and may report presence, but it has no synchronized data, execution, or key authority."),
        ),
        paragraph(
          text("On an already active machine, list devices and approve the pending device by its exact ID or unique prefix. The listing shows each device's class, daemon or browser, and the fingerprint of its two public keys. Approval requires that exact fingerprint, so the machine you approve is the one whose fingerprint you read:"),
        ),
        {
          kind: "commands",
          commands: [
            "oompa device list",
            "oompa device approve <pending-device-id-or-prefix> --fingerprint <value> [--idempotency-key <current-uuidv7>]",
          ],
        },
        paragraph(
          text("After approval, run "),
          code("oompa device pair"),
          text(" on the new machine to retrieve and unwrap its encryption-key envelope. Use "),
          code("oompa device revoke <device-id-or-prefix>"),
          text(" from a different active machine to revoke a device."),
        ),
        paragraph(
          code("oompa auth status"),
          text(" and "),
          code("oompa sync status"),
          text(" expose the account key as a closed status. "),
          code("ready"),
          text(" includes the usable key version. "),
          code("pairing_required"),
          text(" says recovery requires an existing account-key holder and that no remaining holder makes the encrypted content unrecoverable."),
        ),
        paragraph(
          text("Only after this authenticated, registered, active installation reports "),
          code("pairing_required"),
          text(" and the operator has confirmed that no account-key holder remains, run "),
          code("oompa device key-loss --acknowledge-no-key-holders"),
          text(". The command records that explicit observation in the current Oompa cloud identity's isolated local custody, but only when the current auth token generation, identity, auth epoch, registered device, and pairing observation agree exactly. It performs no network, provider, or cloud mutation and does not mint, replace, or delete a key or ciphertext. Signed-out, unregistered, stale-identity, missing-observation, and already-ready states fail with a bounded next command. Pairing the real account key later supersedes the observation."),
        ),
        {
          kind: "notice",
          label: "Unrecoverable encrypted cloud content",
          content: [
            text("After that acknowledgement, account-key status is unrecoverable on this installation. Local provider profiles, sessions, credentials, and execution are unaffected, but existing encrypted cloud content cannot be decrypted without the real account key. Search again for an existing holder and run oompa device pair if one is rediscovered; the real key restores ready status and supersedes the acknowledgement. Only after that renewed holder search is exhausted may the operator explicitly choose erasing and reinitializing the Oompa cloud account as a fallback. Reinitialization creates a new account boundary; it does not regenerate the lost account key or recover old ciphertext."),
          ],
        },
        paragraph(
          text("Approve and revoke create one current UUIDv7 before daemon transport. If the response is lost after dispatch, Oompa prints the exact same-key replay command. Reusing that command recovers the original operation; changing the device or operation under the same key is rejected."),
        ),
        paragraph(
          text("Device credentials are bearer credentials, not hardware-bound proofs. Connection and generation fencing blocks a copied credential from creating a second concurrent connection or surviving revocation, but an uncontested, unrevoked copy can impersonate that device until it is detected and revoked."),
        ),
        paragraph(
          text("Cloud-account erasure is an explicit and irreversible fallback, not the default response to a key-loss acknowledgement. After a renewed holder search is exhausted, run "),
          code("oompa auth delete --acknowledge-erasure"),
          text(" to disable every cloud effect before bounded server-side removal begins. "),
          code("oompa auth status"),
          text(" recovers capability-only progress after authentication records disappear. Erasure does not delete local provider profiles, local sessions, or local encryption custody."),
        ),
      ],
    },
    {
      id: "features",
      heading: "Features",
      blocks: [
        list(
          [
            text("Isolated provider profiles: each named profile has its own user-only "),
            code("CODEX_HOME"),
            text(" for Codex and "),
            code("CLAUDE_CONFIG_DIR"),
            text(" for Claude Code. Each provider owns its authentication state; Oompa never copies or parses provider credentials."),
          ],
          [
            text("Codex usage with provenance: account identity, quota, rate-limit, and token snapshots include their provider source time and freshness. A bounded source-ordered 24-hour ledger supports safe human and JSON pagination without returning raw provider payloads."),
          ],
          [
            text("Compact sessions: list sessions, read provider-neutral user and final assistant messages, and inspect elapsed time plus bounded observed file and Git actions. Protected full-turn inspection remains Codex-only."),
          ],
          [
            text("Personal-home adoption: opt in to discover recent Codex and Claude Code sessions, plus older Codex threads targeted by present Desktop heartbeat automations, then admit them after bounded account, project, liveness, and exact-resume checks. Active and paused automation records both count until deletion or retargeting. Oompa locally parses a bounded automation record but ignores and retains no prompt or working-directory field, keeps later records reachable across daemon restarts, and replaces Desktop's exact fired heartbeat envelope with generic protected text before projection. Account-filtered session lists include admitted rows, which use the same provider-supported public commands, autorespond policy, and approval authority as every Oompa session. Provider-specific limits are identical for native and adopted sessions, and provider APIs do not supply a global lease against every later external resume. Read "),
            link("the session-adoption guide", "https://github.com/hraness/oompa/blob/main/docs/session-adoption.md"),
            text("."),
          ],
          [
            text("Durable controls: send, queue, stop, and keep one editable note per session. Codex and Claude Code can steer an active turn. Provider-native rename remains Codex-only. Provider and desktop effects use exact authority, idempotency keys, and process-generation fencing."),
          ],
          [
            text("Named projects: a project is a canonical directory that may contain several repositories. Changing it affects future turns only."),
          ],
          [
            text("Stable working and shared project memory: a project-bound session writes to its expiring working lane, reads that lane together with durable project memory, and shares one attested page only through conflict-checked adoption. Bound Codex and Claude Code models use closed Oompa tools. Owners use "),
            code("oompa memory status|list|get|search|explain|remember|share"),
            text(" and explicitly enroll canonical project memory through "),
            code("oompa memory hosted list|create|attach|detach|sync"),
            text(". Existing personal adoptions and legacy sessions without a proved Oompa tool binding use the owner memory CLI; adoption does not silently install model tools or replace their conversation. Hosted memory is opt-in and does not upload the working lane. See "),
            link("working and project memory", "https://github.com/hraness/oompa/blob/main/docs/facts-memory.md"),
            text(" for the authority, quota, and recovery boundaries."),
          ],
          [
            text("Attributed peer coordination: each session owns a revocable "),
            code("off|inspect|coordinate"),
            text(" policy. Bound Codex and Claude Code tools can list, inspect, and message only bounded same-project peers; every action retains actor and lineage without granting session administration or approval authority. Retired sessions cannot participate."),
          ],
          [
            text("Agent work coordination: the frozen beta contract specifies bounded local task graphs, fenced attempts, structured submissions, independent reviews, signals, and a resumable work event stream for exact existing sessions."),
          ],
          [
            text("Optional encrypted sync: paired devices share a bounded session projection and submit commands to the one machine holding the execution lease."),
          ],
        ),
        { kind: "subheading", text: "Peer coordination boundary" },
        paragraph(
          text("Peer coordination is separate from Work. It creates no Work, task, attempt, review, or signal membership. The actor and target must be distinct current sessions in the same project. Inspection requires neither policy to be "),
          code("off"),
          text("; messaging requires both exact current policy revisions to remain "),
          code("coordinate"),
          text(". Changing either policy revokes stale inspection and mutation authority."),
        ),
        paragraph(
          code("send"),
          text(" starts a new turn only for an idle target. "),
          code("queue"),
          text(" records bounded untrusted input for later delivery and works for an active target. "),
          code("steer"),
          text(" addresses one exact active turn and is supported by Codex and Claude Code. Peer input cannot resolve approvals, answer protected questions, administer a session, or inherit an identity."),
        ),
        paragraph(
          text("Oompa refuses self-addressing, stale target revisions, causal cycles, and a ninth hop. It admits at most 120 new peer actions per actor and per project in a rolling hour, at most 16 distinct targets per actor in that hour, and at most 64 unsettled inbound queue entries or 1 MiB of their text per target. Complete replay and causal evidence remains for at least seven days. Protected recovery ancestry is never pruned to make room, and the 25,000-action project cap fails closed when protected rows consume it."),
        ),
        paragraph(
          text("Abandoning an uncertain peer delivery does not prove that its message was ignored. Oompa refuses new peer messages from an affected active turn while preserving inspection and owner controls, including stop. A subsequent distinct turn can coordinate again. Older unreleased recovery records with no affected-turn identity conservatively fence that provider thread until the owner explicitly replaces it; a new message alone does not repair missing historical evidence."),
        ),
      ],
    },
    {
      id: "terminal-and-agent-interfaces",
      heading: "Terminal and agent interfaces",
      blocks: [
        { kind: "notice", label: "Conditional walkthrough", content: [text(daemonRolloutNotice)] },
        paragraph(
          text("Run "),
          code("oompa"),
          text(" in a TTY to open a persistent shell. Account and session selections stay in the prompt, live updates redraw wrapped partial input without moving its logical cursor, protected answers are read without terminal echo, and "),
          code("/exit"),
          text(" leaves the daemon running. Pasted command lines use a bounded queue. An overflow or interrupted line flushes the current native terminal queue, retains input custody while discarding through EOF, and exits without executing the tail. Protected terminal documents require a visible stderr TTY plus unpredictable begin and return phrases while raw no-echo mode is active. A failed protected boundary keeps echo disabled while discarding the tail, then closes shell input instead of returning ambiguous bytes to an ordinary prompt. Display loss, termination, and job-control signals restore or fence raw mode before propagation. Live display is buffered while a foreground or protected prompt owns the terminal, and updates from an old session generation are discarded before a new selection is announced. Slow-terminal backpressure drops additional updates behind one explicit omission notice instead of growing memory without bound. One-shot commands provide the same control surface to scripts and agents."),
        ),
        { kind: "subheading", text: "Bounded local status" },
        paragraph(
          code("oompa status [--json]"),
          text(" is a bounded, effect-free read of local SQLite state. It does not start, stop, or contact the daemon; use the network; attempt provider or cloud observation; open a browser; log in; refresh usage; or run recovery. It returns fixed count fields for account, session, interaction, queue, and latest usage states plus at most 50 ID-and-revision action records. Provider and cloud coverage are explicitly "),
          code("not_attempted"),
          text(", and registered and online device counts are unknown rather than zero. The complete JSON result, including its versioned command envelope, is at most 256 KiB."),
        ),
        {
          kind: "commands",
          commands: [
            "oompa status",
            "oompa status --json",
          ],
        },
        { kind: "subheading", text: "Session observation" },
        paragraph(
          code("oompa session status <session> --json"),
          text(" returns status version 2. Oompa produces one typed provider-observation result, attempting the bound provider's reviewed observation path only when the current local state makes one applicable, then reads the session, event cut, interactions, and queue from one local SQLite transaction. Codex supports a native app-server observation read. Claude Code uses its live provider-neutral projection while the exact controller is present. If that controller is absent, Oompa may establish "),
          code("--resume"),
          text(" for the exact conversation only after prior-process exit or an already-completed exact process release is proven; ambiguous custody fails closed as recovery required. Retired Devin sessions use local history only and cannot execute. Execution, attention, provider, and queue remain separate axes, so a headline state cannot hide a recovery condition, pending interaction, response in flight, or queued work. Pending and response-in-flight counts are exact. The result includes at most 10 bounded safe summaries for pending interactions and excludes the session note and private provider thread binding. Every provider turn and item identifier becomes a secret-keyed opaque public alias before status, event, or interaction output. Public observation schemas accept only that exact alias form. The same local installation key keeps aliases coherent across surfaces and daemon restarts without making low-entropy provider IDs guessable from public output. If an existing installation loses that key, Oompa refuses to replace it and directs the operator to restore the original local secret."),
        ),
        paragraph(
          code("oompa session state <session> --json"),
          text(" returns the daemon's latest classification of who must act next: working, needs approval, needs an answer, needs a human action, done, done with followups, done with caveats, or aborted, with an attention flag, a short reason, and a monotonic revision. The daemon classifies the final assistant text of every completed turn with ordered lexical rules in which human-action cues beat approval cues, so a login or a code from email never reads as consent, and it reclassifies when a provider interaction is requested or resolved. The same classification is appended to the session event stream as a "),
          code("session_state"),
          text(" event."),
        ),
        paragraph(
          text("Autorespond answers provider approvals on your behalf. By default every session runs in approval mode "),
          code("auto:all"),
          text(": command and permission approvals are accepted immediately at once scope, never for the session, and each answer leaves an evidence row with the approval class, decision, mode, latency, and outcome. File-change approvals stay pending because the pinned callback does not expose the exact affected paths. "),
          code("oompa autorespond workspace"),
          text(" leaves command and permission grants pending until a provider adapter can attest their complete private authority as workspace-local; a command class or category label such as "),
          code("workspace_write"),
          text(" is not that proof. "),
          code("oompa autorespond off"),
          text(" restores manual approvals; add "),
          code("--session <session>"),
          text(" to override one session and "),
          code("default"),
          text(" to clear the override. Questions and MCP forms are never answered automatically. The baseline limits are three consecutive answers without a human message, ten in an hour, and forty in a day. "),
          code("oompa autorespond status --session <session>"),
          text(" shows the shared counters and the last twenty evidence rows. Only an actual human-authored message resets the consecutive counter; peer messages, Work and scheduled automation, autorespond, and provider-switch handoff messages do not. Notification consent never enables automatic approvals."),
        ),
        paragraph(
          text("After-hours protocol budgets were admitted in v0.6.3. They use a separate local opt-in, disabled on new and upgraded installations. The v0.7.0 release retains this policy without enabling it. After the applicable artifact admission and daemon rollout gates are satisfied, "),
          code("oompa autorespond-after-hours status"),
          text(" reports that policy and its revision. To opt in explicitly, use "),
          code("oompa autorespond-after-hours enable --revision <revision>"),
          text("; use "),
          code("oompa autorespond-after-hours disable --revision <revision>"),
          text(" to turn it off. Outside the configured notification hours, otherwise eligible protocol approvals with complete budget history may use six consecutive, twenty rolling-hour, and eighty rolling-day reservations. Inside hours or without eligible evidence, the baseline applies. Prose always stays at three, ten, and forty. Both paths spend the same counters. Policy changes and schedule boundaries never reset or refund them, and no approval category gains authority."),
        ),
        paragraph(
          text("Each automatic approval reserves its budget before provider dispatch. Reservations survive uncertain results, daemon restarts, and pruning of the display log; a reserved attempt can remain charged even if a later step proves unsent. The final storage transaction checks current consent, source eligibility, and shared accounting before charging. Higher limits additionally require one coherent current schedule and proven history; an unreadable schedule selects the baseline, while invalid consent or accounting refuses admission. Upgrading an existing session to local schema 44 pauses automatic approvals for 24 hours because older retained logs cannot prove its complete budget history, and requires a new human message to reopen its consecutive budget. You can send that message during the hold. The schema-46 after-hours migration also requires a newly finalized human message for every pre-44 session before its higher tier can apply, even if the old hold expired or a human reset occurred before that migration. "),
          code("oompa autorespond status --session <session>"),
          text(" reports the hold's end and the consecutive counter. Manual approvals remain available."),
        ),
        paragraph(
          text("Configuring a gateway key explicitly enables the separate prose-approval path. After strict local gates establish that a completed final assistant message asks only for consent, Oompa sends at most its final 4,000 characters plus session-state and approval-reason metadata to Vercel AI Gateway model "),
          code("openai/gpt-5-nano"),
          text(". It makes one request with a 10-second deadline and no retry. The model cannot create arbitrary text that Oompa will send: the daemon emits either "),
          code("The human has approved. Proceed accordingly."),
          text(" or a byte-exact substring already present in the assistant message. Immediately before dispatch, Oompa checks current consent, the exact completed question, pending interactions, and shared budget again. A newer question or changed authority cancels the stale reply. A timeout, refusal, or other failure leaves the turn for the human. "),
          code("oompa autorespond gateway clear"),
          text(" disables this prose path."),
        ),
        paragraph(
          text("For snapshot-to-stream continuity, start selected-session monitoring at the atomic status cursor. "),
          code("oompa session watch <session> [--cursor <cursor>]"),
          text(" renders a bounded human stream by default; add "),
          code("--jsonl"),
          text(" for a machine stream. Watch is a presentation alias over the existing session event stream, and it drains each output page before advancing its internal cursor. The shell drains every signed pending-interaction continuation page before following newer committed ledger events from the status cursor. Standalone human watch buffers that initial guidance until enumeration is complete, caps the atomic bootstrap at 1 MiB of UTF-8, and writes none of it if enumeration or the bound fails. Resolution guidance appears only from a complete current interaction record and only for a supported decision; an event-only interaction notice points to the exact show command without proposing a mutation. Those events cover bounded lifecycle, tool, interaction, warning, error, and terminal updates, but the ledger is not a complete wake source for every authority transition. Agents that need exact current authority must also repeat bounded session status or pending-interaction reads. Human watch renders assistant and provider-visible reasoning-summary text only after observing that item's start boundary, then redacts credentials and absolute paths with state carried across chunks and interleaved events. A mid-item join omits ambiguous delta suffixes until the next item starts. Gaps, shutdown, malformed repeated starts, and exhausted redaction capacity discard undecided tails with an explicit notice rather than releasing text whose boundary cannot be proved."),
        ),
        {
          kind: "commands",
          commands: [
            "oompa",
            "oompa session status <session> --json",
            "oompa session state <session> --json",
            "oompa session watch <session> --cursor <cursor>",
            "oompa session watch <session> --cursor <cursor> --jsonl",
            "oompa session events <session> --cursor <cursor> --limit <1..200> --wait-ms <0..30000> --json",
            "oompa session events <session> --cursor <cursor> --wait-ms 30000 --jsonl",
            "oompa session interactions <session> --pending --json",
            "oompa interaction inspect <interaction-id> --revision <n> [--handoff-file <absolute-path>]",
          ],
        },
        paragraph(
          text("JSON mode writes one versioned document to stdout and diagnostics to stderr. Event following with "),
          code("--jsonl"),
          text(" writes JSON Lines as the turn progresses; "),
          code("--follow"),
          text(" remains an equivalent compatibility spelling for "),
          code("session events"),
          text(". JSONL delivery is at least once across a pipe or process failure: a crash after an event line but before its page checkpoint can replay that event. Durable consumers deduplicate by "),
          code("(sessionId, streamEpoch, sequence)"),
          text(" and persist each checkpoint only after durably applying all preceding lines. Signed opaque cursors let an agent resume bounded session-list, event, and interaction pages, and durable interaction records keep approvals, questions, permission grants, and MCP form elicitation visible until they are explicitly resolved."),
        ),
        paragraph(
          text("Exact "),
          code("oompa session wait"),
          text(" is unavailable until every wait predicate has a transactional wake revision that changes in the same commit as the observed state. Use status followed by watch from its cursor, or bounded repeated status polling, when a caller needs to wait."),
        ),
        { kind: "subheading", text: "Exit status and JSONL" },
        paragraph(
          text("Every one-shot caller must check the process exit status. Oompa uses this exact mapping:"),
        ),
        list(
          [code("0"), text(": success. A normally stopped event follower, including a user SIGINT, may also return 0.")],
          [code("1"), text(": CONFLICT, AMBIGUOUS, INTERNAL, any other closed failure code, or an unhealthy doctor result.")],
          [code("2"), text(": INVALID_INPUT.")],
          [code("4"), text(": NOT_FOUND.")],
          [code("5"), text(": UNAVAILABLE.")],
          [code("6"), text(": INTERACTION_REQUIRED.")],
          [code("7"), text(": RECOVERY_REQUIRED.")],
        ),
        paragraph(
          text("For non-streaming "),
          code("--json"),
          text(" commands, stdout contains exactly one versioned success or failure envelope. For "),
          code("--jsonl"),
          text(" or its equivalent "),
          code("--follow"),
          text(", stdout contains only JSONL gap, event, and checkpoint frames. If the follower ends on a command error, Oompa leaves all completed frames on stdout and writes exactly one newline-terminated version-1 failure envelope to stderr shaped as "),
          code('{"ok":false,"version":1,"error":{"code":"<code>","message":"<safe-message>"}}'),
          text("; the error may also include bounded details. Callers must consume stdout and stderr independently, must not merge the terminal error into the JSONL stream, and must check the process exit status. A normal user stop or SIGINT may exit 0 without a terminal failure envelope."),
        ),
        paragraph(
          code("interaction show"),
          text(" intentionally returns only a durable safe summary. Before approving a command or permission request, run "),
          code("oompa interaction inspect <interaction-id> --revision <n>"),
          text(" to read the complete authority still held by the live provider callback. A foreground human receives bounded detail on the protected stderr terminal. An agent or other noninteractive caller must first create an empty mode-0600 regular file under a current-user-owned mode-0700 directory and pass its absolute canonical path with "),
          code("--handoff-file"),
          text("; ordinary stdout receives only safe binding and cleanup metadata. On macOS, neither the directory nor file may have an extended ACL, and Oompa rechecks both held descriptors before and after writing. Detail larger than 64 KiB also requires this file path. Read it within that protected boundary and remove it after deciding. Oompa durably admits a bounded file-change prompt so it remains observable and may be declined, but refuses every acceptance because pinned Codex 0.153.2 does not provide the exact affected paths or change detail needed for informed approval."),
        ),
      ],
    },
    {
      id: "presets-and-permissions",
      heading: "Presets and permissions",
      blocks: [
        { kind: "notice", label: "Conditional walkthrough", content: [text(daemonRolloutNotice)] },
        paragraph(
          text("Oompa reviews the bound provider's exact runtime profile immediately before each new provider-native session or turn. For Codex, that refresh includes model, reasoning effort, Fast service tier, permission profile, computer-use capability, and accessible apps. For Claude, Oompa admits only the pinned Fable profile and reviewed host-tool boundary. An unavailable requirement fails before the provider effect. Every successful start records that exact account generation and effective profile; "),
          code("oompa session show"),
          text(" displays the bound provider's history and recorded public profile. Read the provider-neutral Oompa record with "),
          code("oompa session export"),
          text(" or the transcript endpoint. Codex profiles include the requested model, reasoning effort, service tier, permission profile, computer-use capability, and accessible apps; an empty enabled-app list is reported as empty. Claude Code public profiles include the pinned CLI, model, reasoning effort, default permission mode, and stream formats. Oompa privately reviews the exact config-home authority for every Claude effect but omits that custody identity and legacy isolation marker from "),
          code("session show"),
          text("; managed and adopted personal-home sessions therefore share one non-identifying public shape. Each provider remains authoritative for its native permissions, tools, and hidden runtime state."),
        ),
        list(
          [code("low"), text(": Codex Luna Max, currently "), code("gpt-5.6-luna"), text(" with "), code("max"), text(" reasoning.")],
          [code("high"), text(": Codex Astra Max, currently "), code("gpt-6-astra"), text(" with "), code("max"), text(" reasoning.")],
          [code("ultra"), text(": Codex Astra Ultra, currently "), code("gpt-6-astra"), text(" with "), code("ultra"), text(" reasoning.")],
          [code("fable-max"), text(": Claude Code Fable, currently "), code("claude-fable-5-1"), text(" with "), code("max"), text(" reasoning.")],
          [code("fast on|off"), text(": a Codex-only, explicit per-turn Fast or Standard overlay. Claude Code refuses Fast instead of ignoring it. A prior Fast value cannot leak into the next turn.")],
        ),
        paragraph(
          text("New Oompa-created Codex sessions that use "),
          code("high"),
          text(" or "),
          code("ultra"),
          text(", and explicit selections of either preset, use the Astra mapping above (contract 2). The "),
          code("low"),
          text(" and "),
          code("fable-max"),
          text(" bindings are unchanged. Codex sessions already bound to contract 1 keep their exact Sol model and effort until a preset is explicitly selected; unrelated metadata edits, restart recovery, and queued work do not reinterpret an established session."),
        ),
        paragraph(
          code("oompa init"),
          text(" reports the required confirmation without changing local state; "),
          code("oompa init --yes"),
          text(" creates your Documents directory when it is absent, verifies that it is a readable, writable, and traversable canonical directory, and accepts it as the default project. Initialization is a one-shot maintenance command: run it before opening the persistent shell. The shell rejects "),
          code("/init"),
          text(" because its running daemon already owns local state. Codex turns use Codex's "),
          code("auto_review"),
          text(" path, the exact advertised "),
          code(":workspace"),
          text(" permission profile, and the selected project as the runtime workspace root. Codex remains authoritative for the profile's effective sandbox, network policy, computer use, plugins, and protected turn inspection. Claude Code runs in its default interactive permission mode under the selected project and maps supported tool-use requests into Oompa interactions; it does not expose Codex's permission-profile, app, plugin, or protected turn-inspection surfaces."),
        ),
      ],
    },
    {
      id: "plugin-discovery",
      heading: "Plugin discovery",
      blocks: [
        {
          kind: "commands",
          commands: [
            "oompa plugin list <account> [--project <project>] [--refresh]",
            "oompa plugin show <account> <plugin> [--project <project>] [--refresh]",
          ],
        },
        paragraph(
          text("Plugin commands are read-only discovery. They report the exact installed, enabled, availability, authorization, and capability state exposed by the selected isolated Codex profile."),
        ),
        paragraph(
          text("Pinned Codex 0.153.2 has no safely separated install, enablement, and OAuth lifecycle surface: its available lifecycle path can combine installation with enablement and may then open browser authorization. Oompa therefore does not expose plugin install, enable, disable, OAuth, or permission effects. The pinned tool-suggestion form that can invoke that compound plugin or connector lifecycle is also rejected before admission. Other standard MCP forms are brokered only when their pinned schema fits Oompa's closed primitive-field contract. The interaction exposes bounded field names, types, requiredness, constraints, and allowed choices; titles, descriptions, defaults, and answers stay off the public and durable display. Protected submissions are checked for exact required fields, types, bounds, formats, choices, and the absence of additional properties before response preparation. Opaque openai/form, unsupported schema constructs, and URL elicitation fail before durable admission and receive a safe unsupported-capability response with no schema, submitted value, or URL echo. The schema-11 security migration terminalizes and replaces any prerelease URL record before interaction reads. Oompa will keep extended-form and URL handoff unavailable until each has a closed protected path."),
        ),
      ],
    },
    {
      id: "sessions-across-machines",
      heading: "Sessions across machines",
      blocks: [
        paragraph(
          text("The machine that created a provider session remains its only executor in v1. It must be online with its Oompa daemon running and must hold the current execution lease before a remote command can affect Codex or Claude Code. Other paired machines never execute that provider session through one of their own local provider profiles."),
        ),
        paragraph(
          text("Paired machines can read the encrypted projection and submit bounded send, queue, steer, stop, preset, provider-switch, and Codex Fast commands. The origin daemon claims each command by lease generation and idempotency key. Commands remain pending within their deadline while the origin machine is offline; another machine cannot take over or become a second provider writer."),
        ),
        paragraph(
          code("oompa remote show"),
          text(" includes interaction events with a public interaction ID, kind, state, revision, blocking status, bounded safe summary, and a nested version 2 remote policy. That policy is the only remote action authority. Provider request IDs, exact commands, permission values, affected paths, MCP fields, protected answers, and response digests remain local. Another device may decline a pending command, permission, or file-change request with "),
          code("oompa remote resolve <cloud-session> --interaction <id> --revision <n> --decision decline"),
          text(". The web app may answer only a complete non-secret closed-choice user question set whose provider adapter proves exact response translation. Every command, permission, or file-change acceptance or grant, cancel, session scope, free-text or Other response, and every MCP answer stays on the execution machine. A missing policy, nested policy version 1, or unknown policy version exposes no control. The execution daemon rechecks the session, revision, pending state, deadline, requesting device, and exact action membership before using the ordinary local resolution path. "),
          code("oompa remote send --or-steer"),
          text(" lets the execution device decide whether a message steers the active turn or starts a new one, because a remote view of turn state is always slightly stale."),
        ),
        {
          kind: "commands",
          commands: [
            "oompa remote list",
            "oompa remote show <cloud-session>",
            "oompa remote command <uuidv7>",
            "oompa remote send <cloud-session> <message>",
            "oompa remote queue|steer <cloud-session> <message>",
            "oompa remote stop <cloud-session>",
            "oompa remote preset <cloud-session> <low|high|ultra|fable-max>",
            "oompa remote provider <cloud-session> <codex|claude> [--preset <low|high|ultra|fable-max>]",
            "oompa remote fast <cloud-session> <on|off>",
            "oompa remote allow|deny <device-commands|account-linking>",
            "oompa remote policy",
          ],
        },
        paragraph(
          text("A cloud-session selector accepts an exact public ID, a unique public-ID prefix, or an exact synced name. Oompa resolves that selector to the session's exact execution device before enqueueing. Remote mutations accept "),
          code("--idempotency-key <current-uuidv7>"),
          text(" for explicit lost-response recovery; otherwise the CLI creates one and durably recovers an unsettled encrypted outbox entry before accepting a different command. Every enqueue returns its command ID. Use "),
          code("oompa remote command <uuidv7>"),
          text(" to read its bounded current or terminal state and result code, including a failed or ambiguous outcome."),
        ),
        paragraph(
          text("Transcript upload is bound to a durable local stream ledger and the exact remote head and tail. Missing or mismatched evidence pauses upload for only that session. Remote reads, commands, and usage continue, while "),
          code("oompa sync status"),
          text(" keeps the recovery condition visible. Oompa never resets, aliases, overwrites, or destructively reseeds encrypted history."),
        ),
        {
          kind: "commands",
          commands: [
            "oompa sync projection recover <local-session> --acknowledge-gap [--idempotency-key <uuidv7>] [--json]",
          ],
        },
        paragraph(
          text("Projection recovery is an explicit append-only operation. Running it without "),
          code("--acknowledge-gap"),
          text(" performs no daemon call and returns "),
          code("INTERACTION_REQUIRED"),
          text(" with the exact safe next command. JSON mode never prompts. The acknowledged operation preserves all older encrypted cloud history and changes no provider or app state. It opens the next compact stream epoch at sequence "),
          code("H+1"),
          text(", where "),
          code("H"),
          text(" is the exact remote compact head, and baselines only completed turns currently visible in the bounded local projection. Any possibly unsynced interval remains visible to remote readers as a recovery gap."),
        ),
        paragraph(
          text("The CLI creates a current UUIDv7 before daemon transport. Success reports the phase, local session, old and new epochs, boundary head, persistent gap, and an exact same-key replay command. A prepared recovery inside the seven-day server window renews its execution lease and keeps the same exact key. Changed-key retry remains closed while that recovery is unsettled. After the window, exact-key replay first reconciles an already committed effect from immutable lineage. If no effect began, it discards local staging, settles the old attempt as rejected, and clears its authority. Run "),
          code("oompa sync status --json"),
          text(", then start a fresh recovery without "),
          code("--idempotency-key"),
          text(" if recovery is still required."),
        ),
        paragraph(
          text("Session names and notes sync as encrypted metadata, but v1 does not execute remote rename or note commands. Project directories are local-only and are neither synced nor remotely changed."),
        ),
      ],
    },
    {
      id: "privacy",
      heading: "Privacy",
      blocks: privacyBlocks,
    },
    {
      id: "command-reference",
      heading: "Command reference",
      blocks: [
        {
          kind: "commands",
          commands: [
            "oompa init [--yes] [--json]",
            "oompa status [--json]",
            "oompa doctor [--offline] [--json]",
            "oompa auth login --input-stdin|--input-fd <fd>",
            "oompa auth status|logout",
            "oompa auth delete --acknowledge-erasure",
            "oompa usage auto status [codex|claude] [--json]",
            "oompa usage auto on|off [codex|claude] --revision <n> --idempotency-key <uuid> [--json]",
            "oompa usage auto inherit <codex|claude> --revision <n> --idempotency-key <uuid> [--json]",
            "oompa notification-hours status [--json]",
            "oompa notification-hours set --start <HH:MM> --end <HH:MM> --timezone <IANA-zone> --revision <n> [--json]",
            "oompa notification-email status [--json]",
            "oompa notification-email enable|disable --revision <n> [--json]",
            "oompa device list",
            "oompa device pair",
            "oompa device key-loss --acknowledge-no-key-holders",
            "oompa device approve <device-id-or-prefix> --fingerprint <value> [--idempotency-key <uuidv7>] [--json]",
            "oompa device revoke <device-id-or-prefix> [--idempotency-key <uuidv7>] [--json]",
            "oompa account add <label>",
            "oompa account login <profile> [--provider <codex|claude>] [--device-code] [--handoff-file <absolute-path>] [--idempotency-key <uuid>]",
            "oompa account login-cancel <profile> [--provider codex]",
            "oompa account login-cancel <profile> --provider claude --attempt-id <attempt-id> --provider-generation <n> --idempotency-key <uuid> --acknowledge-child-exited",
            "oompa account login-cancel <profile> --provider devin --attempt-id <attempt-id> --provider-generation <n> --idempotency-key <uuid> --acknowledge-child-exited",
            "oompa account logout <profile>",
            "oompa account list",
            "oompa account list [--provider <codex|claude>] [--json]",
            "oompa account show <profile> [--provider <codex|claude>]",
            "oompa account show <profile> --provider devin  (retired local history and cleanup only)",
            "oompa account usage [profile] [--refresh]",
            "oompa account usage-history <profile> [--from <UTC-RFC3339>] [--through <UTC-RFC3339>] [--limit <1..100>] [--cursor <cursor>]",
            "oompa plugin list <account> [--project <project>] [--refresh]",
            "oompa plugin show <account> <plugin> [--project <project>] [--refresh]",
            "oompa project add --path <directory> [--name <name>]",
            "oompa project list",
            "oompa project use <project>",
            "oompa session list [--account <profile>] [--archived] [--limit <1..100>] [--cursor <cursor>]",
            "oompa session adoption status [--provider <codex|claude>]",
            "oompa session adoption enable <account> --provider <codex|claude>",
            "oompa session adoption disable --provider <codex|claude>",
            "oompa session discover [--provider <codex|claude>]",
            "oompa session show <session> [--detail]",
            "oompa session status <session> [--json]",
            "oompa session watch <session> [--cursor <cursor>] [--jsonl]",
            "oompa session events <session> [--cursor <cursor>] [--limit <1..200>] [--wait-ms <0..30000>] [--json|--jsonl|--follow]",
            "oompa session interactions <session> [--pending] [--limit <1..100>] [--cursor <cursor>]",
            "oompa memory status <session> [--json]",
            "oompa memory list <session> [--working-only] [--continuation <token>] [--json]",
            "oompa memory get <session> <key> [--working-only] [--continuation <token>] [--json]",
            "oompa memory search <session> [--working-only] [--continuation <token>] <text> [--json]",
            "oompa memory explain <session> <query-id> <row> [--json]",
            "oompa memory remember <session> <key> --title <title> --summary <summary> [--language <tag>] [--idempotency-key <uuid>] [--json] -- <body>",
            "oompa memory share <session> <key> --reason <reason> [--idempotency-key <uuid>] [--json]",
            "oompa memory hosted list [--json]",
            "oompa memory hosted create <project> [--idempotency-key <uuid>] [--json]",
            "oompa memory hosted attach <project> <hosted-space-id> [--json]",
            "oompa memory hosted detach <project> --generation <n> [--json]",
            "oompa memory hosted sync <project> [--json]",
            "oompa session start <account> [--project <project>] [--provider <codex|claude>] [--preset <low|high|ultra|fable-max>] [--fast] [--idempotency-key <uuid> [--preset-contract <1|2>]]",
            "oompa session send|queue|steer <session> [--attach <path>]... <message>",
            "oompa session stop|recover|abandon <session>",
            "oompa session rename <session> <name>",
            "oompa session archive|unarchive <session>",
            "oompa session note get|edit|clear <session>",
            "oompa session note set <session> <note>",
            "oompa session state <session> [--json]",
            "oompa session peer-policy get <session> [--json]",
            "oompa session peer-policy set <session> <off|inspect|coordinate> --revision <n> [--json]",
            "oompa session preset <session> <low|high|ultra|fable-max>",
            "oompa session switch <session> --provider <codex|claude> [--preset <low|high|ultra|fable-max>] [--account <account>] [--idempotency-key <uuid> [--preset-contract <1|2>]]",
            "oompa session export <session> [--format <trajectory|json>] [--out <path>]",
            "oompa session fast <session> <on|off>",
            "oompa session project <session> <project>",
            "oompa session switch <session> --provider <codex|claude> [--preset <low|high|ultra|fable-max>] [--account <account>]",
            "oompa session export <session> [--format <trajectory|json>] [--out <path>]",
            "oompa session task list <session>",
            "oompa session task show <session> <task-id>",
            "oompa session task create <session> --name <name> --every-minutes <15..10080> [--paused] [--idempotency-key <uuid>] -- <prompt>",
            "oompa session task edit <session> <task-id> --revision <n> [--name <name>] [--every-minutes <15..10080>] [--pause|--resume] [--idempotency-key <uuid>] [-- <replacement-prompt>]",
            "oompa session task delete <session> <task-id> --revision <n> [--idempotency-key <uuid>]",
            "oompa work protocol [--operation <kind>|--type <name>|--topic <topic>]",
            "oompa work apply --input-stdin|--input-fd <fd>",
            "oompa work snapshot <work> [--actor <session>]",
            "oompa work task <task> [--history-limit <1..50>] [--history-cursor <cursor>]",
            "oompa work poll <work> [--actor <session>] [--cursor <event-cursor>] [--action-cursor <action-cursor>] [--limit <1..50>] [--wait-ms <0..30000>]",
            "oompa work events <work> [--cursor <cursor>] [--limit <1..200>] [--wait-ms <0..30000>] [--json|--jsonl|--follow]",
            "oompa work watch <work> [--cursor <cursor>]",
            "oompa interaction list [session] [--pending] [--limit <1..100>] [--cursor <cursor>]",
            "oompa interaction show <interaction-id>",
            "oompa interaction inspect <interaction-id> --revision <n> [--handoff-file <absolute-path>]",
            "oompa interaction decide <interaction-id> --revision <n> --decision <once|session|decline|cancel>",
            "oompa interaction grant|answer <interaction-id> --revision <n> --input-stdin|--input-fd <fd>",
            "oompa interaction submit <interaction-id> --revision <n> --action <accept|decline|cancel> [--input-stdin|--input-fd <fd>]",
            "oompa autorespond on|workspace|off|default|status [--session <session>] [--json]",
            "oompa autorespond gateway set [--from-fd <fd>] [--json]",
            "oompa autorespond gateway clear [--json]",
            "oompa autorespond-after-hours status [--json]",
            "oompa autorespond-after-hours enable|disable --revision <n> [--json]",
            "oompa remote list [--limit <1..100>]",
            "oompa remote show <cloud-session>",
            "oompa remote command <uuidv7>",
            "oompa remote send|queue|steer <cloud-session> <message>",
            "oompa remote send --or-steer <cloud-session> <message>",
            "oompa remote resolve <cloud-session> --interaction <uuid> --revision <n> --decision <decline>",
            "oompa remote stop <cloud-session>",
            "oompa remote preset <cloud-session> <low|high|ultra|fable-max>",
            "oompa remote provider <cloud-session> <codex|claude> [--preset <low|high|ultra|fable-max>]",
            "oompa remote fast <cloud-session> <on|off>",
            "oompa remote allow|deny <device-commands|account-linking>",
            "oompa remote policy",
            "oompa turn inspect <session> <turn> [--json]",
            "oompa sync status|now",
            "oompa sync projection recover <local-session> --acknowledge-gap [--idempotency-key <uuidv7>] [--json]",
            "oompa daemon start [--json]",
            "oompa daemon status|stop [--json]",
            "oompa daemon run",
          ],
        },
        paragraph(
          text("Account, project, and local-session selectors accept an exact ID or an unambiguous case-insensitive label. Cloud-session selectors accept an exact public ID, a unique public-ID prefix, or an exact synced name. Device selectors accept an exact ID or unique prefix. Ambiguity lists candidates and performs no effect. The CLI creates and sends an idempotency key before every provider effect; pass "),
          code("--idempotency-key <uuid>"),
          text(" to reuse one after a lost response. If a local mutation response is uncertain, Oompa returns the generated key and the exact replay arguments without repeating the command payload. Put those arguments before any "),
          code("--"),
          text(" delimiter when rerunning the otherwise unchanged command. A source-sensitive Codex "),
          code("session start"),
          text(" or provider-switch replay includes both "),
          code("--idempotency-key"),
          text(" and its immutable "),
          code("--preset-contract"),
          text("; do not omit or change either after an update. The preset-contract option is a source-binding field that requires an explicit idempotency key and is rejected for stable requests. With an existing key, a source-matched applied request replays its result and an effect-started request remains recovery-required. With a key that has no stored row, only this build's active source contract may authorize the one fresh effect; the field cannot select a retired route."),
        ),
        paragraph(
          text("An older session-start release did not print the source contract, so its exact historical alias meaning must be supplied explicitly when replaying its key. For a v0.5.0 Codex start that omitted the then-default preset, preserve every other original option and add "),
          code("--preset high --preset-contract 1"),
          text("; v0.5.0 High and Ultra both meant Sol. Use "),
          code("--preset-contract 2"),
          text(" for an untagged Astra-era request whose original runtime evidence actually meant Astra. Neither selector can resume a contractless prepared row. Contract 1 cannot authorize a fresh effect under the current Astra binding; contract 2 can authorize the exact Astra request when the key has no stored row, just as a newly generated key can. If the originating meaning cannot be proved, use the retained old release rather than guessing. A contractless prepared row has no supported cancellation or retirement command. It must reach a terminal settlement through exact replay under the originating release, or the update remains blocked. Do not use a fresh key or "),
          code("session abandon"),
          text(" as a workaround; that command applies only to an existing recovery-required session and never cancels prepared start or switch authority. "),
          code("session preset"),
          text(" has no idempotency-key replay; resolve and inspect it before updating. session recover accepts only exact, kind-specific provider proof. session abandon never retries or deletes provider state and releases only the local recovery authority. Remote mutations require a current UUIDv7 when this option is supplied. With "),
          code("--json"),
          text(", stdout contains one versioned object; diagnostics stay on stderr."),
        ),
        paragraph(
          code("interaction show"),
          text(" lists each safe requested permission category and each exact question ID. Complete live command and permission authority is available only through the revision-bound protected "),
          code("interaction inspect"),
          text(" path described above. A permission grant reads "),
          code('{"permissions":["<requested-name>"]}'),
          text(" and a question response reads "),
          code('{"answers":{"<question-id>":{"answers":["<answer>"]}}}'),
          text(" through protected input. Those permission-name and question-answer document shapes are Codex-specific. The live Codex adapter rehydrates selected permission names to their exact private provider values immediately before the response write; those values never enter display, storage, logs, or sync. Claude Code tool-use requests map to Oompa's provider-neutral interaction kinds and accept only the response choices that exact callback offers."),
        ),
        paragraph(
          text("Every admitted callback carries a local deadline anchored when the provider delivered it. Oompa caps the pending interval at 30 minutes and honors a shorter valid provider interval, including an immediate zero interval. At the deadline it writes one provider-neutral timeout error through the same write-ahead ledger, never invents an answer or grant, and quarantines the provider generation if the write may have escaped. "),
          code("interaction show"),
          text(" displays the safe local deadline; nested remote policy version 2 carries the same absolute deadline so readers can suppress an expired control, while the daemon remains authoritative."),
        ),
        paragraph(
          text("For a standard MCP form, interaction show returns the exact public field contract without defaults or answers. Accept reads one protected document shaped as "),
          code('{"content":{...}}'),
          text(" from nonterminal stdin or a file descriptor. Decline and cancel accept no content. JSON mode never prompts, and validation failures identify the contract failure without echoing a submitted value."),
        ),
        paragraph(
          text("Projection recovery uses the local-session selector rules. It requires "),
          code("--acknowledge-gap"),
          text(" and a canonical UUIDv7; the CLI generates a current key when it is omitted. A stored exact key remains the only admissible replay while recovery is unsettled. Inside the seven-day window, a prepared replay renews its lease and can apply. After the window, replay reconciles immutable committed lineage or safely settles known-no-effect authority as rejected; status then determines whether to retry with a fresh generated key."),
        ),
        paragraph(
          text("The beta does not expose destructive local profile or project deletion. "),
          code("account logout"),
          text(" asks Codex app-server to remove that profile's Codex login while Oompa preserves its local session history. Oompa does not implement Claude Code sign-out; use Claude Code's own authentication flow inside the isolated profile."),
        ),
      ],
    },
    {
      id: "authority-boundaries",
      heading: "Authority boundaries",
      blocks: [
        paragraph(
          text("Codex app-server and Claude Code remain authoritative for their provider-native authentication, sessions, execution, tools, approvals, models, and hidden runtime state; Codex additionally owns its plugin, usage, and native transcript surfaces. Oompa owns isolated profiles, the durable provider-neutral conversation record and commands, process generations, local projections, optional encrypted sync, and recovery records. The frozen work contract assigns local coordination records to Oompa rather than either provider runtime."),
        ),
        paragraph(
          text("Cloud service availability is not required for local provider authentication, local execution, local work coordination, local recovery, or reading local sessions. Provider accounts remain independent subscriptions. Oompa does not pool quota or replay a limited turn under another account or provider. The separately adopted provider-usage contract permits bounded managed Codex movement only under fresh local authority; explicit sessions, work tasks, Claude accounts, and cross-machine execution remain outside that boundary. SQLite remains the local work execution authority; Turso is deferred and non-authoritative."),
        ),
      ],
    },
    {
      id: "project",
      heading: "Project",
      blocks: [
        paragraph(
          text("Oompa is MIT licensed. Read the "),
          link("security policy", links.security),
          text(" before reporting a vulnerability, use "),
          link("private vulnerability reporting", links.privateSecurityReport),
          text(" for suspected security issues, and read the "),
          link("contribution guide", links.contributing),
          text(" before a large change."),
        ),
      ],
    },
  ],
};

const renderMarkdownInline = (content: readonly InlineContent[]): string =>
  content
    .map((part) => {
      switch (part.kind) {
        case "code":
          return `\`${part.value}\``;
        case "link":
          return `[${part.label}](${part.href})`;
        case "text":
          return part.value;
      }
    })
    .join("");

const indentMarkdownBlock = (value: string, indentation: string): string =>
  value.split("\n").map((line) => `${indentation}${line}`).join("\n");

const renderMarkdownBlock = (block: ContentBlock, headingLevel: number): string => {
  switch (block.kind) {
    case "commands":
      return `\`\`\`text\n${block.commands.join("\n")}\n\`\`\``;
    case "list":
      return block.items.map((item) => `- ${renderMarkdownInline(item)}`).join("\n");
    case "notice":
      return `> **${block.label}.** ${renderMarkdownInline(block.content)}`;
    case "ordered-list": {
      return block.items.map((item, index) => {
        const marker = `${(index + 1).toString()}. `;
        const indentation = " ".repeat(marker.length);
        const parts = [`${marker}${renderMarkdownInline(item.content)}`];
        if (item.commands !== undefined) {
          parts.push(indentMarkdownBlock(
            `\`\`\`text\n${item.commands.join("\n")}\n\`\`\``,
            indentation,
          ));
        }
        if (item.afterCommands !== undefined) {
          parts.push(indentMarkdownBlock(renderMarkdownInline(item.afterCommands), indentation));
        }
        return parts.join("\n\n");
      }).join("\n\n");
    }
    case "paragraph":
      return renderMarkdownInline(block.content);
    case "subheading":
      return `${"#".repeat(headingLevel)} ${block.text}`;
  }
};

export const renderMarkdownBlocks = (blocks: readonly ContentBlock[], headingLevel: number): string =>
  blocks.map((block) => renderMarkdownBlock(block, headingLevel)).join("\n\n");

export const renderPrivacyMarkdown = (content: PublicContent = publicContent): string => {
  const privacy = content.sections.find((section) => section.id === "privacy");
  if (privacy === undefined) {
    throw new Error("Public content is missing its privacy section.");
  }

  return [
    "# Privacy",
    `This policy describes the Oompa beta data boundary. The hosted sync service is live as an ${hostedBetaLabel}. Besides completed turns, the daemon streams the current turn's assistant text to the hosted service in encrypted, redacted batches that expire within six hours; reasoning summaries are included only when you enable show-thinking for a session, and raw reasoning is never uploaded.`,
    renderMarkdownBlocks(privacy.blocks, 2),
    `Report a suspected boundary violation through [private vulnerability reporting](${content.links.privateSecurityReport}).`,
  ].join("\n\n") + "\n";
};

export const renderLlmsText = (content: PublicContent = publicContent): string =>
  [
    `# ${content.productName}`,
    "",
    `> ${content.description}`,
    "",
    content.thesis,
    content.statusLine,
    "",
    ...(isAdmittedRelease(content.releaseVersion) ? [] : [
      content.installNotice,
      `Admitted release installation notes: ${content.links.admittedInstall}`,
    ]),
    isAdmittedRelease(content.releaseVersion)
      ? `Install the admitted v${content.releaseVersion} local CLI artifact: ${content.installCommand}`
      : `Only after immutable GitHub release admission, install the v${content.releaseVersion} local CLI artifact: ${content.installCommand}`,
    `Verify local prerequisites without cloud access: ${content.doctorCommand}`,
    content.daemonRolloutNotice,
    `Initialize only after the rollout prerequisite is satisfied: ${content.initCommand}`,
    "",
    `Repository: ${content.links.github}`,
    `Documentation: ${content.links.documentation}`,
    `Security: ${content.links.security}`,
    `Privacy: ${content.links.privacy}`,
    "",
    "## Documentation",
    "",
    `- [Overview](${content.siteUrl}/docs/)`,
    `- [Get started](${content.siteUrl}/docs/start/)`,
    `- [Web workspace](${content.siteUrl}/docs/web/)`,
    `- [Sessions and accounts](${content.siteUrl}/docs/sessions/)`,
    `- [Command reference](${content.siteUrl}/docs/reference/)`,
    `- [Availability and rollout](${content.siteUrl}/docs/status/)`,
    "",
    "Each documentation page provides a canonical Markdown version at its index.md path.",
    "",
  ].join("\n");

const escapeXml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

export const renderSitemapXml = (content: PublicContent = publicContent): string => {
  const urls = siteDocumentPaths.map((path) => `  <url>
    <loc>${escapeXml(`${content.siteUrl}${path}`)}</loc>
  </url>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
};

export const findSection = (content: PublicContent, id: string): ContentSection => {
  const section = content.sections.find((candidate) => candidate.id === id);
  if (section === undefined) {
    throw new Error(`Unknown public content section: ${id}`);
  }
  return section;
};
