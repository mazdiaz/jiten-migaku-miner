import { redirect } from "next/navigation";
import { auth, signIn } from "../../auth";
import { isOwner } from "../../server/access";

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (isOwner(session?.user?.id, process.env.OWNER_GITHUB_ID)) redirect("/");
  const { error } = await searchParams;
  const configured = !!(
    process.env.AUTH_SECRET &&
    process.env.AUTH_GITHUB_ID &&
    process.env.AUTH_GITHUB_SECRET &&
    process.env.OWNER_GITHUB_ID
  );
  return (
    <main className="login-shell panel">
      <p className="eyebrow">Private vocabulary workspace</p>
      <h1>JITEN → MIGAKU MINER</h1>
      <p>Sign in to access your vocabulary, study progress, and mining queue.</p>
      {error && (
        <p role="alert">
          Sign-in could not be completed. Only the configured owner account has access.
        </p>
      )}
      {configured ? (
        <form
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/" });
          }}
        >
          <button type="submit">Continue with GitHub</button>
        </form>
      ) : (
        <p role="status">
          Setup is required. Configure the authentication environment variables described in the
          README, then restart the app.
        </p>
      )}
    </main>
  );
}
