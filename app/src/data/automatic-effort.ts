/** Browser-local finite preference only: no prompt, account, session or key. */
import { useCallback, useState, useSyncExternalStore } from "react";

import { automaticEffortPreference, automaticEffortStorageKey } from "../model/automatic-effort";

const changeEvent = "oompa-automatic-effort-change";
const preference = automaticEffortPreference({
  read: () => localStorage.getItem(automaticEffortStorageKey),
  write: (value) => { localStorage.setItem(automaticEffortStorageKey, value); },
});

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === automaticEffortStorageKey || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(changeEvent, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(changeEvent, listener);
  };
}

export function useAutomaticEffort() {
  const enabled = useSyncExternalStore(subscribe, preference.read, () => false);
  const [notice, setNotice] = useState<string | null>(null);
  const setEnabled = useCallback((next: boolean) => {
    setNotice(preference.write(next) ? null
      : "Automatic effort is off for this tab. Your browser could not save the preference; check it again after reloading.");
    window.dispatchEvent(new Event(changeEvent));
  }, []);
  return { enabled, notice, setEnabled };
}
