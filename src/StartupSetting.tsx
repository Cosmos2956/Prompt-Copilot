import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";

type StartupStatus = { enabled: boolean | null; error: string | null };

export function StartupSetting() {
  const [status, setStatus] = useState<StartupStatus>({
    enabled: null,
    error: null,
  });
  const [working, setWorking] = useState(false);
  const busy = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    const refresh = async () => {
      const request = ++generation.current;
      try {
        const next = await invoke<StartupStatus>("startup_status");
        if (!disposed && request === generation.current) setStatus(next);
      } catch {
        if (!disposed && request === generation.current)
          setStatus({
            enabled: null,
            error: "Could not read the Windows startup setting.",
          });
      }
    };
    const listener = getCurrentWindow().listen<StartupStatus>(
      "startup-changed",
      (event) => {
        if (!disposed) {
          ++generation.current;
          setStatus(event.payload);
        }
      },
    );
    void listener.then(refresh).catch(() => {
      if (!disposed)
        setStatus({
          enabled: null,
          error:
            "Could not prepare startup settings. Reopen Settings to retry.",
        });
    });
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      mounted.current = false;
      window.removeEventListener("focus", refresh);
      void listener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  const change = async (enabled: boolean) => {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    const request = ++generation.current;
    try {
      const next = await invoke<StartupStatus>("set_startup_enabled", {
        enabled,
      });
      if (mounted.current && request === generation.current) setStatus(next);
    } catch {
      if (mounted.current)
        setStatus({
          enabled: null,
          error:
            "Could not change the Windows startup setting. Reopen Settings to retry.",
        });
    } finally {
      busy.current = false;
      if (mounted.current) setWorking(false);
    }
  };

  return (
    <section
      aria-labelledby="startup-title"
      className="border-t border-white/10 pt-3"
    >
      <h2
        id="startup-title"
        className="mb-2 text-xs uppercase tracking-wider text-slate-400"
      >
        Startup
      </h2>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={status.enabled ?? false}
          disabled={working || status.enabled === null}
          onChange={(event) => void change(event.target.checked)}
        />
        Start Prompt Copilot with Windows
      </label>
      <p className="mt-1 text-xs text-slate-400">
        Starts hidden in the tray after sign-in.
      </p>
      {status.enabled === null && !status.error && (
        <p role="status" className="mt-1 text-xs text-slate-400">
          Checking startup setting…
        </p>
      )}
      {status.error && (
        <p role="alert" className="mt-1 text-xs text-rose-300">
          {status.error}
        </p>
      )}
    </section>
  );
}
