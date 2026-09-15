"use client";
import { useEffect, useState } from "react";
import { ImportPanel } from "./features/ImportPanel";
import { ResultsPanel } from "./features/ResultsPanel";
import { ReviewPanel } from "./features/ReviewPanel";
import type { CloudStatus } from "./study-runtime";

export function Miner() {
  const [status, setStatus] = useState<CloudStatus>({
    ready: false,
    error: false,
    message: "Loading saved vocabulary…",
  });
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void import("./study-runtime")
      .then(({ mountStudy }) => {
        if (!cancelled) dispose = mountStudy(setStatus);
      })
      .catch(() => {
        if (!cancelled)
          setStatus({
            ready: false,
            error: true,
            message: "The study interface could not load. Please reload.",
          });
      });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
  return (
    <>
      <div
        className="cloud-status"
        data-error={status.error}
        role={status.error ? "alert" : "status"}
      >
        {status.message}{" "}
        {status.error && (
          <button type="button" onClick={() => window.location.reload()}>
            Reload workspace
          </button>
        )}
      </div>
      <main className="app-shell" inert={!status.ready || status.error}>
        <header className="hero">
          <p className="eyebrow">Private · Synced · Migaku-friendly</p>
          <h1>JITEN → MIGAKU MINER</h1>
          <p className="hero-copy">
            Import your Jiten vocabulary and Migaku known words, then review, practice, and mine
            sentences. Your progress is saved across devices.
          </p>
        </header>
        <ImportPanel />
        <ResultsPanel />
      </main>
      <ReviewPanel />
    </>
  );
}
