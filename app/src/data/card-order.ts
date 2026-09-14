/**
 * The manual grid order, bound to this browser.
 *
 * The arrangement is a per-viewer preference, not account state: it is never
 * uploaded, never encrypted into a projection, and never sent as a command, so
 * two readers of the same account keep their own grids. That makes local
 * storage the right home for it alongside the app's finite preferences.
 *
 * `app/src/auth/no-persistent-storage.test.ts` explicitly allows this module to
 * name `localStorage`. What it stores is a bounded list of opaque session
 * public ids: no projection text, no name, no token, no key.
 */
import { useCallback, useEffect, useMemo, useReducer } from "react";

import {
  canNudge,
  cardOrderReducer,
  cardOrderStorageKey,
  readCardOrder,
  writeCardOrder,
  type CardOrderStorage,
} from "../model/card-order";

/**
 * Reads and writes go straight at the global. Every one of them can throw —
 * private browsing, blocked site data, a full quota — and every caller in
 * `model/card-order.ts` treats a throw as "there is no stored order", so
 * nothing here guards a call that the model already guards.
 */
export const browserCardOrderStorage: CardOrderStorage = {
  read: () => localStorage.getItem(cardOrderStorageKey),
  remove: () => { localStorage.removeItem(cardOrderStorageKey); },
  write: (value: string) => { localStorage.setItem(cardOrderStorageKey, value); },
};

export type CardOrderControls = Readonly<{
  /** Whether the reader has arranged anything, for the reset menu item. */
  arranged: boolean;
  canMove: (displayed: readonly string[], publicId: string, direction: "left" | "right") => boolean;
  /** Drop the dragged card onto the slot another card holds. */
  move: (
    displayed: readonly string[],
    activePublicId: string,
    overPublicId: string,
  ) => void;
  /** The keyboard path: one step in the displayed sequence. */
  nudge: (
    displayed: readonly string[],
    publicId: string,
    direction: "left" | "right",
  ) => void;
  order: readonly string[];
  reset: () => void;
}>;

export function useCardOrder(
  storage: CardOrderStorage = browserCardOrderStorage,
): CardOrderControls {
  const [order, dispatch] = useReducer(
    cardOrderReducer,
    storage,
    (initial) => readCardOrder(initial),
  );

  // The write follows the state rather than sitting inside the reducer, so the
  // reducer stays a pure fold and a double invocation cannot double a write.
  useEffect(() => { writeCardOrder(storage, order); }, [order, storage]);

  const move = useCallback((
    displayed: readonly string[],
    activePublicId: string,
    overPublicId: string,
  ) => {
    dispatch({ activePublicId, displayed, overPublicId, type: "move" });
  }, []);

  const nudge = useCallback((
    displayed: readonly string[],
    publicId: string,
    direction: "left" | "right",
  ) => {
    dispatch({ direction, displayed, publicId, type: "nudge" });
  }, []);

  const reset = useCallback(() => { dispatch({ type: "clear" }); }, []);

  return useMemo(() => ({
    arranged: order.length > 0,
    canMove: canNudge,
    move,
    nudge,
    order,
    reset,
  }), [move, nudge, order, reset]);
}
