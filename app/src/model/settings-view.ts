/**
 * The settings screen's view models.
 *
 * One decrypted `DeviceRegistryPayload` plus the device row it belongs to
 * becomes one machine card; every machine's scheduled tasks are flattened into
 * one read-only list; and the session heads whose decrypted metadata says
 * `archived` become the unarchive list. All of it is a pure fold, so
 * `bun test ./app` checks the derivations without a document, a network, or an
 * account key.
 */
import {
  decodeHistoricalProfileKey,
  parseProfileBindingPayload,
  type CanonicalProfile,
  type DeviceRegistryAccount,
  type DeviceRegistryPayload,
  type DeviceRegistryProject,
  type DeviceRegistryScheduledTask,
  type DeviceRegistrySessionAdoption,
  type MemorySummaryPayload,
  type MemorySummaryPeerAction,
  type MemorySummaryPeerPolicy,
  type MemorySummarySpace,
  type NotificationHoursPolicy,
  type ProfileBindingPayload,
} from "../oompa/cloud";
import type { ApprovalMode, PresetChoice } from "./settings-commands";

/**
 * `deviceRegistryHeartbeatMs` in `src/cloud/daemon-bridge.ts`: a daemon
 * republishes its registry when an input changed and otherwise once a minute.
 */
export const registryHeartbeatIntervalMs = 60_000;

/** Three missed registry heartbeats before a machine reads as offline. */
export const registryHeartbeatToleranceMs = 3 * registryHeartbeatIntervalMs;

export type SessionAdoptionProvider = keyof DeviceRegistrySessionAdoption;

/**
 * Personal-home access is a machine-local consent boundary. Settings shows
 * the exact local command instead of manufacturing a browser mutation.
 */
export function personalSessionAdoptionCommand(
  provider: SessionAdoptionProvider,
  enabled: boolean,
): string {
  return enabled
    ? `oompa session adoption disable --provider ${provider}`
    : `oompa session adoption enable <account> --provider ${provider}`;
}

export type MachineDeviceState = Readonly<{
  /** Required for exact-profile display; older callers remain alias-only. */
  deviceClass?: "browser" | "daemon";
  keyVersion?: number;
  online: boolean;
  status: "pending" | "active" | "revoked";
}>;

export type MachineOnlineInput = Readonly<{
  /** The registry's own device row from `devices:list`, or null when it is gone. */
  device: MachineDeviceState | null;
  heartbeatAt: number;
  now: number;
}>;

/**
 * A machine is online when the hosted presence table still holds its device
 * connection, and otherwise when its registry heartbeat is recent enough that
 * presence has simply not caught up. A future heartbeat does not establish
 * freshness. A revoked or missing device row is always offline, whatever the
 * last published heartbeat said.
 */
export function isMachineOnline(input: MachineOnlineInput): boolean {
  const { device, heartbeatAt, now } = input;
  if (device === null || device.status !== "active") return false;
  if (device.online) return true;
  if (!Number.isFinite(heartbeatAt) || heartbeatAt <= 0 || !Number.isFinite(now)) return false;
  const age = now - heartbeatAt;
  return age >= 0 && age <= registryHeartbeatToleranceMs;
}

export type ScheduledTaskKindLabel = "Oompa";

const scheduledTaskKindLabels: Readonly<
  Record<DeviceRegistryScheduledTask["kind"], ScheduledTaskKindLabel>
> = { hra_conversation: "Oompa" };

export function scheduledTaskKindLabel(
  kind: DeviceRegistryScheduledTask["kind"],
): ScheduledTaskKindLabel {
  return scheduledTaskKindLabels[kind];
}

export type ScheduledTaskView = Readonly<{
  cadence: string;
  id: string;
  kind: DeviceRegistryScheduledTask["kind"];
  kindLabel: ScheduledTaskKindLabel;
  label: string;
  machineLabel: string;
  nextRunAt: number | null;
  sessionPublicId: string | null;
}>;

export type ProfileBindingView = Readonly<{
  profile: Extract<CanonicalProfile, { provider: "codex" }>;
  status: "current";
}> | Readonly<{
  profile: null;
  status: "inactive" | "stale" | "unreadable" | "unsupported";
}>;

export type MachineView = Readonly<{
  // Local switches as this machine last published them. A registry written
  // before device commands existed reads as the shipped defaults: commands
  // allowed and linking denied. Email absence never reads as enabled.
  accountLinkingAllowed: boolean;
  accounts: readonly DeviceRegistryAccount[];
  /** Null unless the composite hosted freshness fence matches decrypted policy. */
  attentionEmailEnabled: boolean | null;
  daemonVersion: string;
  defaultApprovalMode: ApprovalMode;
  defaultPreset: PresetChoice;
  /** Null when the daemon predates the projection; the first project stands in. */
  defaultProjectPublicId: string | null;
  deviceCommandsAllowed: boolean;
  devicePublicId: string;
  /** Current hosted device authority; a stale registry can outlive this row. */
  deviceStatus: MachineDeviceState["status"] | null;
  heartbeatAt: number;
  label: string;
  memorySummary: MemorySummaryPayload | null;
  memorySummaryFreshness: "current" | "inactive" | "stale" | "unreadable" | "unsupported";
  online: boolean;
  notificationHours: NotificationHoursPolicy | null;
  notificationHoursStatus: "available" | "unreadable" | "unsupported";
  notificationPolicyFreshness: "current" | "stale" | "unreadable" | "unsupported";
  notificationPolicyRevision: number | null;
  projects: readonly DeviceRegistryProject[];
  /** Only a verified current observation has an exact profile to render. */
  profileBinding: ProfileBindingView;
  proseAutorespondConfigured: boolean;
  revision: number;
  scheduledTasks: readonly ScheduledTaskView[];
  /** Null means the daemon predates this optional registry projection. */
  sessionAdoption: DeviceRegistrySessionAdoption | null;
  showThinkingDefault: boolean;
  updatedAt: number;
}>;

export type MachineViewInput = Readonly<{
  attentionEmailEnabled?: boolean | null;
  device: MachineDeviceState | null;
  devicePublicId: string;
  keyVersion?: number;
  memorySummaryReady?: boolean;
  now: number;
  notificationHours?: NotificationHoursPolicy | null;
  notificationHoursStatus?: MachineView["notificationHoursStatus"];
  notificationPolicyFreshness?: MachineView["notificationPolicyFreshness"];
  notificationPolicyRevision?: number | null;
  memorySummary?: MemorySummaryPayload | null;
  memorySummaryStatus?: "available" | "unreadable" | "unsupported";
  profileBinding?: ProfileBindingPayload | null;
  profileBindingReady?: boolean;
  profileBindingStatus?: "available" | "unreadable" | "unsupported";
  payload: DeviceRegistryPayload;
  revision: number;
  updatedAt: number;
}>;

/** A display observation, never an input to preset or provider selection. */
function profileBindingView(input: MachineViewInput): ProfileBindingView {
  const unavailable = (status: Exclude<ProfileBindingView["status"], "current">): ProfileBindingView =>
    ({ profile: null, status });
  if (
    input.device === null
    || input.device.status !== "active"
    || input.device.deviceClass === "browser"
  ) return unavailable("inactive");
  if (
    input.device.deviceClass !== "daemon"
    || input.device.keyVersion === undefined
    || input.keyVersion === undefined
    || input.profileBindingReady !== true
    || !Number.isFinite(input.now)
    || input.now <= 0
  ) return unavailable("unsupported");
  if (input.device.keyVersion !== input.keyVersion) return unavailable("inactive");
  if (input.profileBindingStatus === "unreadable") return unavailable("unreadable");
  if (input.profileBindingStatus !== "available" || input.profileBinding == null) {
    return unavailable("unsupported");
  }
  const observation = parseProfileBindingPayload(input.profileBinding);
  if (
    observation === null
    || observation.observedAt <= 0
    || observation.registryRevision !== input.revision
    || observation.observedAt !== input.payload.heartbeatAt
    || observation.preset !== input.payload.defaultPreset
  ) return unavailable("unreadable");
  if (Math.abs(input.now - observation.observedAt) > registryHeartbeatToleranceMs) {
    return unavailable("stale");
  }
  const profile = decodeHistoricalProfileKey(observation.profileKey);
  return profile?.provider === "codex"
    ? { profile, status: "current" }
    : unavailable("unreadable");
}

export function toMachineView(input: MachineViewInput): MachineView {
  const { payload } = input;
  const deviceActive = input.device?.status === "active";
  // A caller that forgets the hosted-clock gate must not accidentally fold a
  // cross-machine timestamp against a browser wall clock.
  const memorySummaryReady = input.memorySummaryReady ?? false;
  const memorySummary = deviceActive && memorySummaryReady ? input.memorySummary ?? null : null;
  const memorySummaryStatus = memorySummaryReady
    ? input.memorySummaryStatus ?? "unsupported"
    : "unsupported";
  const memorySummaryFreshness = !deviceActive
    ? "inactive"
    : !memorySummaryReady
      ? "unsupported"
    : memorySummaryStatus === "unreadable"
      ? "unreadable"
      : memorySummaryStatus === "unsupported" || memorySummary === null
        ? "unsupported"
        : memorySummary.observedAt > input.now + registryHeartbeatToleranceMs
          || input.now - memorySummary.observedAt > registryHeartbeatToleranceMs
          ? "stale"
          : "current";
  return {
    accountLinkingAllowed: payload.accountLinkingAllowed ?? false,
    accounts: payload.accounts,
    attentionEmailEnabled: input.attentionEmailEnabled ?? null,
    daemonVersion: payload.daemonVersion,
    defaultApprovalMode: payload.defaultApprovalMode,
    defaultPreset: payload.defaultPreset,
    defaultProjectPublicId: payload.defaultProjectPublicId ?? null,
    deviceCommandsAllowed: payload.deviceCommandsAllowed ?? true,
    devicePublicId: input.devicePublicId,
    deviceStatus: input.device?.status ?? null,
    heartbeatAt: payload.heartbeatAt,
    label: payload.machineLabel,
    memorySummary,
    memorySummaryFreshness,
    online: isMachineOnline({
      device: input.device,
      heartbeatAt: payload.heartbeatAt,
      now: input.now,
    }),
    projects: payload.projects,
    profileBinding: profileBindingView(input),
    proseAutorespondConfigured: payload.proseAutorespondConfigured,
    revision: input.revision,
    scheduledTasks: payload.scheduledTasks.map((task) => ({
      cadence: task.cadence,
      id: task.id,
      kind: task.kind,
      kindLabel: scheduledTaskKindLabel(task.kind),
      label: task.label,
      machineLabel: payload.machineLabel,
      nextRunAt: task.nextRunAt,
      sessionPublicId: task.sessionPublicId,
    })),
    sessionAdoption: payload.sessionAdoption ?? null,
    showThinkingDefault: payload.showThinkingDefault,
    notificationHours: input.notificationHours ?? null,
    notificationHoursStatus: input.notificationHoursStatus
      ?? (input.notificationHours == null ? "unsupported" : "available"),
    notificationPolicyFreshness: input.notificationPolicyFreshness ?? "unsupported",
    notificationPolicyRevision: input.notificationPolicyRevision ?? null,
    updatedAt: input.updatedAt,
  };
}

export type HostedMemoryObservationView = Readonly<{
  devicePublicId: string;
  freshness: MachineView["memorySummaryFreshness"] | "bounded" | "missing";
  machineLabel: string;
  space: MemorySummarySpace | null;
}>;

export type HostedMemorySpaceView = Readonly<{
  agreement: "agreed" | "disagreed" | "insufficient";
  canonicalSpaceId: string;
  observations: readonly HostedMemoryObservationView[];
  projectLabels: readonly string[];
}>;

const memoryObservationFingerprint = (space: MemorySummarySpace): string => JSON.stringify({
  bindingDigest: space.bindingDigest,
  head: space.head,
  recordCount: space.recordCount,
});

/**
 * Groups by portable identity while retaining every device observation. Only
 * current observations participate in agreement; stale and unreadable rows
 * remain visible but can never make two devices look converged.
 */
export function hostedMemorySpaces(
  machines: readonly MachineView[],
): readonly HostedMemorySpaceView[] {
  const ids = new Set<string>();
  for (const machine of machines) {
    for (const space of machine.memorySummary?.spaces ?? []) ids.add(space.canonicalSpaceId);
  }
  return [...ids].sort().map((canonicalSpaceId) => {
    const observations = machines.map((machine): HostedMemoryObservationView => {
      const space = machine.memorySummary?.spaces.find((entry) =>
        entry.canonicalSpaceId === canonicalSpaceId) ?? null;
      return {
        devicePublicId: machine.devicePublicId,
        freshness: space === null && machine.memorySummaryFreshness === "current"
          ? machine.memorySummary?.coverage.spaces === "bounded" ? "bounded" : "missing"
          : machine.memorySummaryFreshness,
        machineLabel: machine.label,
        space,
      };
    });
    const current = observations.filter((observation): observation is HostedMemoryObservationView & {
      space: MemorySummarySpace;
    } => observation.freshness === "current"
      && observation.space !== null
      && observation.space.recordCount !== null);
    const fingerprints = new Set(current.map((observation) =>
      memoryObservationFingerprint(observation.space)));
    return {
      agreement: current.length < 2
        ? "insufficient"
        : fingerprints.size === 1
          ? "agreed"
          : "disagreed",
      canonicalSpaceId,
      observations,
      projectLabels: [...new Set(current.map((observation) => observation.space.projectLabel))]
        .sort((left, right) => left.localeCompare(right)),
    };
  });
}

export type HostedPeerPolicyView = MemorySummaryPeerPolicy & Readonly<{
  devicePublicId: string;
  machineLabel: string;
}>;

export type HostedPeerActionView = MemorySummaryPeerAction & Readonly<{
  devicePublicId: string;
  machineLabel: string;
}>;

export function hostedPeerPolicies(machines: readonly MachineView[]): readonly HostedPeerPolicyView[] {
  return machines.flatMap((machine) => machine.memorySummaryFreshness === "current"
    ? (machine.memorySummary?.peerPolicies ?? []).map((policy) => ({
        ...policy,
        devicePublicId: machine.devicePublicId,
        machineLabel: machine.label,
      }))
    : []).sort((left, right) => right.updatedAt - left.updatedAt
      || left.machineLabel.localeCompare(right.machineLabel)
      || left.session.ref.localeCompare(right.session.ref));
}

export function hostedPeerActions(machines: readonly MachineView[]): readonly HostedPeerActionView[] {
  return machines.flatMap((machine) => machine.memorySummaryFreshness === "current"
    ? (machine.memorySummary?.peerActions ?? []).map((action) => ({
        ...action,
        devicePublicId: machine.devicePublicId,
        machineLabel: machine.label,
      }))
    : []).sort((left, right) => right.updatedAt - left.updatedAt
      || left.machineLabel.localeCompare(right.machineLabel)
      || left.actor.ref.localeCompare(right.actor.ref)
      || left.target.ref.localeCompare(right.target.ref));
}

export type AttentionEmailPresentation = Readonly<{
  description: string;
  label: "disabled" | "enabled" | "refresh needed" | "unavailable";
  tone: "accent" | "attention" | "neutral";
}>;

/** Read-only copy for the settings row; this function grants no command authority. */
export function attentionEmailPresentation(
  machine: Pick<
    MachineView,
    "attentionEmailEnabled" | "notificationPolicyFreshness" | "notificationPolicyRevision"
  >,
): AttentionEmailPresentation {
  if (
    machine.notificationPolicyFreshness === "current"
    && machine.notificationPolicyRevision !== null
    && machine.attentionEmailEnabled !== null
  ) {
    return {
      description: `Last published local email opt-in at notification policy revision ${machine.notificationPolicyRevision}.`,
      label: machine.attentionEmailEnabled ? "enabled" : "disabled",
      tone: machine.attentionEmailEnabled ? "accent" : "neutral",
    };
  }
  if (machine.notificationPolicyFreshness === "stale") {
    return {
      description: "The encrypted setting and hosted policy revision do not match yet.",
      label: "refresh needed",
      tone: "attention",
    };
  }
  if (machine.notificationPolicyFreshness === "unreadable") {
    return {
      description: "This machine’s email opt-in projection could not be verified.",
      label: "unavailable",
      tone: "attention",
    };
  }
  return {
    description: "Unavailable on this machine’s current daemon.",
    label: "unavailable",
    tone: "neutral",
  };
}

/** Online machines first, then by label, then by device id so ties are stable. */
export function sortMachines(machines: readonly MachineView[]): readonly MachineView[] {
  return [...machines].sort((left, right) => {
    if (left.online !== right.online) return left.online ? -1 : 1;
    const byLabel = left.label.localeCompare(right.label);
    return byLabel === 0 ? left.devicePublicId.localeCompare(right.devicePublicId) : byLabel;
  });
}

/**
 * Every machine's scheduled tasks in one list, soonest run first. A task with no
 * next run is not overdue, it is simply unscheduled, so it sorts last.
 */
export function allScheduledTasks(
  machines: readonly MachineView[],
): readonly ScheduledTaskView[] {
  return machines
    .flatMap((machine) => machine.scheduledTasks)
    .sort((left, right) => {
      if (left.nextRunAt === right.nextRunAt) return left.label.localeCompare(right.label);
      if (left.nextRunAt === null) return 1;
      if (right.nextRunAt === null) return -1;
      return left.nextRunAt - right.nextRunAt;
    });
}

export function machineLabelsByDevice(
  machines: readonly MachineView[],
): ReadonlyMap<string, string> {
  return new Map(machines.map((machine) => [machine.devicePublicId, machine.label]));
}

export type SessionHeadSummary = Readonly<{
  executionDevicePublicId: string;
  publicId: string;
  state: "active" | "idle" | "terminal" | "orphaned";
  updatedAt: number;
}>;

export type CommandTarget = Readonly<{
  executionDevicePublicId: string;
  sessionPublicId: string;
}>;

/**
 * Where a machine-wide setting command is sent.
 *
 * Commands are session-indexed and the hosted validator refuses a session in a
 * terminal or orphaned state, so a daemon default is addressed to the machine's
 * most recently updated live session. A machine with no live session cannot be
 * configured from the browser at all, and the caller says so instead of
 * enqueuing a command that would be rejected.
 */
export function commandTargetForMachine(
  heads: readonly SessionHeadSummary[],
  devicePublicId: string,
): CommandTarget | null {
  let best: SessionHeadSummary | null = null;
  for (const head of heads) {
    if (head.executionDevicePublicId !== devicePublicId) continue;
    if (head.state === "terminal" || head.state === "orphaned") continue;
    if (best === null || head.updatedAt > best.updatedAt) best = head;
  }
  return best === null
    ? null
    : { executionDevicePublicId: best.executionDevicePublicId, sessionPublicId: best.publicId };
}

export type ArchivedSessionInput = Readonly<{
  executionDevicePublicId: string;
  metadata: Readonly<{ archived?: boolean; name: string | null; retiredProvider?: "devin" }> | null;
  publicId: string;
  updatedAt: number;
}>;

export type ArchivedSessionView = Readonly<{
  executionDevicePublicId: string;
  machineLabel: string | null;
  publicId: string;
  retiredProvider?: "devin";
  title: string;
  updatedAt: number;
}>;

export const shortIdCharacters = 12;

export function shortSessionId(publicId: string): string {
  return publicId.slice(0, shortIdCharacters);
}

/**
 * The archived list. `archived` lives in the encrypted session metadata, so a
 * head whose metadata has not decrypted yet is simply absent rather than
 * guessed at, and the newest archived session sorts first.
 */
export function archivedSessionRows(
  sessions: readonly ArchivedSessionInput[],
  machineLabels: ReadonlyMap<string, string>,
): readonly ArchivedSessionView[] {
  return sessions
    .filter((session) => session.metadata?.archived === true)
    .map((session) => ({
      executionDevicePublicId: session.executionDevicePublicId,
      machineLabel: machineLabels.get(session.executionDevicePublicId) ?? null,
      publicId: session.publicId,
      ...(session.metadata?.retiredProvider === undefined
        ? {} : { retiredProvider: session.metadata.retiredProvider }),
      title: session.metadata?.name ?? shortSessionId(session.publicId),
      updatedAt: session.updatedAt,
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export type AccountRowView = Readonly<{
  /** The machine's local opt-in: `oompa remote allow account-linking`. */
  accountLinkingAllowed: boolean;
  /** The machine-wide device-command kill switch. */
  deviceCommandsAllowed: boolean;
  label: string;
  machineLabel: string;
  provider: DeviceRegistryAccount["provider"];
  publicId: string;
  status: DeviceRegistryAccount["status"];
  targetDevicePublicId: string;
}>;

export const accountStatusLabels: Readonly<
  Record<DeviceRegistryAccount["status"], string>
> = Object.freeze({
  login_pending: "Login pending",
  recovery_required: "Recovery required",
  signed_in: "Signed in",
  signed_out: "Signed out",
});

export function accountRows(machines: readonly MachineView[]): readonly AccountRowView[] {
  return machines.flatMap((machine) => machine.accounts.map((account) => ({
    accountLinkingAllowed: machine.accountLinkingAllowed,
    deviceCommandsAllowed: machine.deviceCommandsAllowed,
    label: account.label,
    machineLabel: machine.label,
    provider: account.provider,
    publicId: account.publicId,
    status: account.status,
    targetDevicePublicId: machine.devicePublicId,
  })));
}

/** Browser login controls exist only when both local machine gates admit them. */
export function accountBrowserLoginAllowed(account: AccountRowView): boolean {
  return account.provider === "codex"
    && account.deviceCommandsAllowed
    && account.accountLinkingAllowed;
}
