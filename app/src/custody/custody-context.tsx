import { useConvex } from "convex/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { clearCompactHistoryCache } from "../data/compact-history";
import {
  accountCurrent,
  currentRegistration,
  finishBind,
  listKeyEnvelopes,
  beginBind as beginBindReference,
  presenceConnect,
  presenceDisconnect,
  presenceHeartbeat,
  registerDevice,
} from "../data/functions";
import { releaseHeldAttachments } from "../data/sent-attachments";
import { clearSessionMetadataCache } from "../data/session-metadata";
import {
  parseAccountContext,
  parseBindChallenge,
  parseDeviceSummary,
  parseKeyEnvelopes,
  type AccountContext,
} from "../data/wire";
import { accountKeyVersion, enrollmentPollMs, presenceHeartbeatMs } from "../env";
import {
  createCloudUuidV7,
  randomKeyBytes,
  signDeviceBind,
  unwrapAccountDataKey,
} from "../oompa/cloud";
import { createCancellation } from "../lib/cancellation";
import { isAuthorityError, wipeBytes } from "./authority";
import { deviceKeyFingerprint } from "./fingerprint";
import { readDeviceKeys, readOrCreateDeviceKeys, type BrowserDeviceKeys } from "./keystore";
import { newConnectionId, presenceArgs, type PresenceIdentity } from "./presence";
import {
  browserDeviceLabel,
  encryptDeviceLabel,
  randomBindNonce,
  randomOpaqueId,
  registrationIntent,
  registrationRequestDigest,
  selectKeyEnvelope,
  submitBrowserDeviceRegistration,
} from "./registration";

export type EnrollmentStage =
  /** The account has no active device, so a browser cannot be the first one. */
  | "needs_first_device"
  /** Keys are not generated yet: this tab has never enrolled. */
  | "needs_registration"
  /** Keys exist and a device row exists, but this auth session is not bound. */
  | "needs_bind"
  /** Registered and waiting for `oompa device approve` against the fingerprint. */
  | "awaiting_approval"
  /** The device row was revoked from another device. */
  | "revoked"
  /** Registered, approved, and bindable. */
  | "active"
  | "unknown";

export type UnlockedIdentity = Readonly<{
  authEpoch: number;
  credentialGeneration: number;
  devicePublicId: string;
  keyVersion: number;
  userPublicId: string;
}>;

type CustodyCommon = Readonly<{
  busy: boolean;
  devicePublicId: string | null;
  enroll: () => Promise<void>;
  enrollment: EnrollmentStage;
  error: string | null;
  fingerprint: string | null;
  refresh: () => Promise<void>;
  reportAuthorityFailure: (error: unknown) => void;
  /** Retries opening the account key after a failed automatic attempt. */
  unlock: () => Promise<void>;
}>;

/**
 * `unlocking` is an approved, bindable device whose account key is not in
 * memory yet: the tab opens it on its own as soon as the registration reads as
 * active, and shows the enrollment screen with the error if that fails. There
 * is no locked state a reader can enter or leave by hand.
 */
export type Custody =
  | (CustodyCommon & Readonly<{
      identity: UnlockedIdentity;
      key: Uint8Array;
      state: "unlocked";
    }>)
  | (CustodyCommon & Readonly<{ state: "unlocking" | "unenrolled" }>);

const CustodyContext = createContext<Custody | null>(null);

/**
 * The unwrapped account key never leaves this module's state. It is held as raw
 * bytes because `encryptRemoteCommand`, `decryptCompactEvents`, and
 * `decryptDetailEvents` take the key material rather than a `CryptoKey`; the
 * bytes are overwritten in place on any authority failure and on unload, and
 * they are never written to storage of any kind.
 */
type Unlocked = Readonly<{ identity: UnlockedIdentity; key: Uint8Array }>;

function stageFor(
  account: AccountContext | null,
  keys: BrowserDeviceKeys | null,
): EnrollmentStage {
  if (account === null) return "unknown";
  if (account.device === null) {
    if (keys === null) {
      return account.hasActiveDevices ? "needs_registration" : "needs_first_device";
    }
    return "needs_bind";
  }
  if (account.device.status === "revoked") return "revoked";
  if (account.device.status === "pending") return "awaiting_approval";
  return keys === null || keys.publicId !== account.device.publicId
    ? "needs_first_device"
    : "active";
}

export function CustodyProvider({ children }: Readonly<{ children: ReactNode }>) {
  const convex = useConvex();
  const [account, setAccount] = useState<AccountContext | null>(null);
  const [keys, setKeys] = useState<BrowserDeviceKeys | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState<Unlocked | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const presence = useRef<{ connectionId: string; sequence: number } | null>(null);
  const unlockedRef = useRef<Unlocked | null>(null);

  unlockedRef.current = unlocked;

  const disconnectPresence = useCallback(
    (identity: UnlockedIdentity) => {
      const current = presence.current;
      presence.current = null;
      if (current === null) return;
      const presenceIdentity: PresenceIdentity = {
        authEpoch: identity.authEpoch,
        credentialGeneration: identity.credentialGeneration,
        devicePublicId: identity.devicePublicId,
        userPublicId: identity.userPublicId,
      };
      void presenceArgs({
        connectionId: current.connectionId,
        identity: presenceIdentity,
        kind: current.sequence === 0 ? "connect" : "heartbeat",
        sequence: current.sequence,
      })
        .then(async (args) => await convex.mutation(presenceDisconnect, args))
        .catch(() => undefined);
    },
    [convex],
  );

  const dropKey = useCallback(() => {
    const current = unlockedRef.current;
    if (current !== null) disconnectPresence(current.identity);
    wipeBytes(current?.key);
    unlockedRef.current = null;
    setUnlocked(null);
    // Decrypted projection text lives in tab-local caches so a card does not
    // re-decrypt on every render. Dropping the key without dropping them would
    // leave plaintext readable without the key that produced it.
    clearCompactHistoryCache();
    clearSessionMetadataCache();
    // The same argument covers the attachment bytes this tab sent: they are
    // reader-supplied file contents held in memory for the transcript
    // thumbnails, and they must not outlive the key either.
    releaseHeldAttachments();
  }, [disconnectPresence]);

  const reportAuthorityFailure = useCallback((failure: unknown) => {
    if (!isAuthorityError(failure)) return;
    dropKey();
    setError("This device lost its authority on the account. Sign in again.");
  }, [dropKey]);

  const guard = useCallback(<T,>(run: () => Promise<T>) => async (): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await run();
    } catch (failure: unknown) {
      reportAuthorityFailure(failure);
      setError(failure instanceof Error ? failure.message : "The operation failed.");
      return null;
    } finally {
      setBusy(false);
    }
  }, [reportAuthorityFailure]);

  const readAccount = useCallback(async (): Promise<AccountContext> => {
    const value = parseAccountContext(await convex.query(accountCurrent, {}));
    if (value === null) throw new Error("Cloud account response is invalid.");
    return value;
  }, [convex]);

  const refresh = useCallback(async () => {
    const [nextAccount, nextKeys] = await Promise.all([readAccount(), readDeviceKeys()]);
    setAccount(nextAccount);
    setKeys(nextKeys);
    if (nextAccount.device === null || nextAccount.device.status !== "active") {
      // A pending registration is only visible through the auth-session bind.
      const registration = parseDeviceSummary(await convex.query(currentRegistration, {}));
      if (registration !== null && nextAccount.device === null) {
        setAccount({
          ...nextAccount,
          device: {
            credentialGeneration: 1,
            keyVersion: accountKeyVersion,
            publicId: registration.publicId,
            revision: registration.revision,
            status: registration.status,
          },
        });
      }
    }
  }, [convex, readAccount]);

  const enroll = useCallback(async () => {
    const context = await readAccount();
    if (!context.hasActiveDevices) {
      throw new Error(
        "A browser is never the first device on an account. Enroll a machine with oompa installed first.",
      );
    }
    const deviceKeys = await readOrCreateDeviceKeys();
    setKeys(deviceKeys);
    const provisionalKey = randomKeyBytes();
    try {
      const encryptedLabel = await encryptDeviceLabel({
        devicePublicId: deviceKeys.publicId,
        keyVersion: accountKeyVersion,
        label: browserDeviceLabel(navigator.platform),
        provisionalKey,
        userPublicId: context.userPublicId,
      });
      const intent = registrationIntent({
        encryptedLabel,
        idempotencyKey: createCloudUuidV7(Date.now()),
        keyVersion: accountKeyVersion,
        publicId: deviceKeys.publicId,
        signingPublicKey: deviceKeys.signingPublicKey,
        wrappingPublicKey: deviceKeys.wrappingPublicKey,
      });
      const requestDigest = await registrationRequestDigest(provisionalKey, intent);
      await submitBrowserDeviceRegistration({
        intent,
        mutate: async (request) => await convex.mutation(registerDevice, request),
        requestDigest,
      });
    } finally {
      wipeBytes(provisionalKey);
    }
    await refresh();
  }, [convex, readAccount, refresh]);

  const unlock = useCallback(async () => {
    const deviceKeys = await readDeviceKeys();
    if (deviceKeys === null) {
      throw new Error("This browser has no enrolled device keys.");
    }
    let context = await readAccount();
    if (context.device === null) {
      const challengeId = randomOpaqueId("bind");
      const nonce = randomBindNonce();
      const challenge = parseBindChallenge(await convex.mutation(beginBindReference, {
        challengeId,
        devicePublicId: deviceKeys.publicId,
        nonce,
      }));
      if (
        challenge === null
        || challenge.challengeId !== challengeId
        || challenge.devicePublicId !== deviceKeys.publicId
        || challenge.nonce !== nonce
      ) throw new Error("Cloud device bind response is invalid.");
      await convex.action(finishBind, {
        challengeId,
        signature: await signDeviceBind(deviceKeys.signing.privateKey, {
          challengeId,
          devicePublicId: deviceKeys.publicId,
          nonce,
        }),
      });
      context = await readAccount();
    }
    const device = context.device;
    if (device === null || device.status !== "active" || device.publicId !== deviceKeys.publicId) {
      throw new Error("This device is not approved on the account yet.");
    }
    const envelopes = parseKeyEnvelopes(await convex.query(listKeyEnvelopes, {}));
    const envelope = selectKeyEnvelope(envelopes, device.keyVersion);
    if (envelope === null) {
      throw new Error("No account key envelope exists for this device yet.");
    }
    const key = await unwrapAccountDataKey(envelope, deviceKeys.wrapping.privateKey, {
      accountKeyVersion: device.keyVersion,
      devicePublicId: device.publicId,
      userPublicId: context.userPublicId,
    });
    const identity: UnlockedIdentity = {
      authEpoch: context.authEpoch,
      credentialGeneration: device.credentialGeneration,
      devicePublicId: device.publicId,
      keyVersion: device.keyVersion,
      userPublicId: context.userPublicId,
    };
    setAccount(context);
    setKeys(deviceKeys);
    unlockedRef.current = { identity, key };
    setUnlocked({ identity, key });

    const connectionId = newConnectionId();
    const args = await presenceArgs({
      connectionId,
      identity,
      kind: "connect",
      sequence: 0,
    });
    await convex.mutation(presenceConnect, args);
    presence.current = { connectionId, sequence: 0 };
  }, [convex, readAccount]);

  // Device key fingerprint, shown so the operator can compare it before running
  // `oompa device approve`.
  useEffect(() => {
    if (keys === null) {
      setFingerprint(null);
      return;
    }
    const run = createCancellation();
    void deviceKeyFingerprint(keys.signingPublicKey, keys.wrappingPublicKey)
      .then((value) => { if (run.live()) setFingerprint(value); })
      .catch(() => { if (run.live()) setFingerprint(null); });
    return () => { run.cancel(); };
  }, [keys]);

  // First read, then a bounded poll while a registration is waiting for
  // approval from a machine with oompa installed.
  const stage = stageFor(account, keys);
  const guardedRefresh = useMemo(() => guard(refresh), [guard, refresh]);
  useEffect(() => {
    void guardedRefresh();
  }, [guardedRefresh]);
  useEffect(() => {
    if (stage !== "awaiting_approval") return;
    const timer = setInterval(() => { void guardedRefresh(); }, enrollmentPollMs);
    return () => { clearInterval(timer); };
  }, [guardedRefresh, stage]);

  // Presence heartbeat, only while the document is visible.
  useEffect(() => {
    if (unlocked === null) return;
    const identity = unlocked.identity;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const current = presence.current;
      if (current === null) return;
      const sequence = current.sequence + 1;
      void presenceArgs({
        connectionId: current.connectionId,
        identity,
        kind: "heartbeat",
        sequence,
      })
        .then(async (args) => {
          await convex.mutation(presenceHeartbeat, args);
          presence.current = { connectionId: current.connectionId, sequence };
        })
        .catch((failure: unknown) => { reportAuthorityFailure(failure); });
    }, presenceHeartbeatMs);
    return () => { clearInterval(timer); };
  }, [convex, reportAuthorityFailure, unlocked]);

  // The account key is opened as soon as the device reads as approved and
  // bindable, once per registration reading. A failed attempt leaves the
  // error on the enrollment screen with a retry, rather than looping.
  const guardedUnlock = useMemo(() => guard(unlock), [guard, unlock]);
  const unlockAttemptedFor = useRef<string | null>(null);
  const bindable = stage === "active" || stage === "needs_bind";
  const attemptKey = bindable
    ? `${stage}:${account?.device?.publicId ?? ""}:${String(account?.device?.revision ?? 0)}`
    : null;
  useEffect(() => {
    if (attemptKey === null || unlocked !== null || busy) return;
    if (unlockAttemptedFor.current === attemptKey) return;
    unlockAttemptedFor.current = attemptKey;
    void guardedUnlock();
  }, [attemptKey, busy, guardedUnlock, unlocked]);

  // The key never survives the page.
  useEffect(() => {
    const onUnload = () => { dropKey(); };
    window.addEventListener("pagehide", onUnload);
    return () => { window.removeEventListener("pagehide", onUnload); };
  }, [dropKey]);

  const value = useMemo<Custody>(() => {
    const common: CustodyCommon = {
      busy,
      devicePublicId: keys?.publicId ?? null,
      enroll: async () => { await guard(enroll)(); },
      enrollment: stage,
      error,
      fingerprint,
      refresh: async () => { await guardedRefresh(); },
      reportAuthorityFailure,
      unlock: async () => {
        unlockAttemptedFor.current = attemptKey;
        await guardedUnlock();
      },
    };
    if (unlocked !== null) {
      return { ...common, identity: unlocked.identity, key: unlocked.key, state: "unlocked" };
    }
    return { ...common, state: bindable ? "unlocking" : "unenrolled" };
  }, [
    attemptKey,
    bindable,
    busy,
    enroll,
    error,
    fingerprint,
    guard,
    guardedRefresh,
    guardedUnlock,
    keys,
    reportAuthorityFailure,
    stage,
    unlocked,
  ]);

  return <CustodyContext.Provider value={value}>{children}</CustodyContext.Provider>;
}

export function useCustody(): Custody {
  const value = useContext(CustodyContext);
  if (value === null) throw new Error("useCustody used outside the custody provider.");
  return value;
}

export type UnlockedCustody = Extract<Custody, { state: "unlocked" }>;

export function useUnlockedCustody(): UnlockedCustody {
  const custody = useCustody();
  if (custody.state !== "unlocked") throw new Error("The account key is not open in this tab.");
  return custody;
}
