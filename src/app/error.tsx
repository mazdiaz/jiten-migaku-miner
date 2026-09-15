"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="login-shell panel">
      <h1>Unable to load your workspace</h1>
      <p>Your saved data has not been changed.</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
