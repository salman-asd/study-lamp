"use client";

import * as React from "react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth/AuthProvider";
import { DEFAULT_GENERAL_PREFS, type GeneralPrefs } from "@/lib/generalPrefs";
import {
  getGeneralPrefsRemote, readCachedGeneralPrefs, updateGeneralPrefsRemote, writeCachedGeneralPrefs,
} from "@/lib/generalPrefsClient";

export type PrefSaveState = "idle" | "saving" | "saved" | "error";

interface GeneralPrefsContextValue {
  prefs: GeneralPrefs;
  /** True once the server copy has loaded (or failed to). Until then `prefs` is the cache or the defaults. */
  ready: boolean;
  saveState: PrefSaveState;
  /** Optimistic update; rolls back and toasts on failure. No request when the value did not change. */
  setPref: <K extends keyof GeneralPrefs>(key: K, value: GeneralPrefs[K]) => Promise<void>;
}

const GeneralPrefsContext = React.createContext<GeneralPrefsContextValue>({
  prefs: DEFAULT_GENERAL_PREFS,
  ready: false,
  saveState: "idle",
  setPref: async () => undefined,
});

/** Loads users/{uid}.generalPrefs once per login (like AiLanguageProvider) and shares it with every page. */
export function GeneralPrefsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const uid = user?.uid;
  const [prefs, setPrefs] = React.useState<GeneralPrefs>(DEFAULT_GENERAL_PREFS);
  const [ready, setReady] = React.useState(false);
  const [saveState, setSaveState] = React.useState<PrefSaveState>("idle");
  const prefsRef = React.useRef(prefs);
  prefsRef.current = prefs;
  const userRef = React.useRef(user);
  userRef.current = user;

  React.useEffect(() => {
    let active = true;
    setReady(false);
    setSaveState("idle");
    if (!user || !uid) {
      setPrefs(DEFAULT_GENERAL_PREFS);
      return () => { active = false; };
    }
    const cached = readCachedGeneralPrefs(uid);
    if (cached) setPrefs(cached);
    void (async () => {
      try {
        const remote = await getGeneralPrefsRemote(await user.getIdToken());
        if (!active) return;
        setPrefs(remote);
        writeCachedGeneralPrefs(uid, remote);
      } catch {
        // The cached or default values keep working; saving will retry the server.
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => { active = false; };
    // Keyed on uid so token refreshes do not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  const setPref = React.useCallback(async <K extends keyof GeneralPrefs>(key: K, value: GeneralPrefs[K]) => {
    const currentUser = userRef.current;
    const previous = prefsRef.current;
    if (!currentUser || previous[key] === value) return;
    const optimistic = { ...previous, [key]: value };
    setPrefs(optimistic);
    writeCachedGeneralPrefs(currentUser.uid, optimistic);
    setSaveState("saving");
    try {
      const saved = await updateGeneralPrefsRemote(await currentUser.getIdToken(), { [key]: value } as Partial<GeneralPrefs>);
      setPrefs(saved);
      writeCachedGeneralPrefs(currentUser.uid, saved);
      setSaveState("saved");
    } catch (error) {
      setPrefs(previous);
      writeCachedGeneralPrefs(currentUser.uid, previous);
      setSaveState("error");
      toast.error(error instanceof Error ? error.message : "Couldn't save this setting.");
    }
  }, []);

  const value = React.useMemo(() => ({ prefs, ready, saveState, setPref }), [prefs, ready, saveState, setPref]);
  return <GeneralPrefsContext.Provider value={value}>{children}</GeneralPrefsContext.Provider>;
}

export function useGeneralPrefs(): GeneralPrefsContextValue {
  return React.useContext(GeneralPrefsContext);
}
