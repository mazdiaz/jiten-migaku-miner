import { redirect } from "next/navigation";
import { auth, signOut } from "../auth";
import { Miner } from "../components/miner";
import { isOwner } from "../server/access";

export default async function Home() {
  const session = await auth();
  if (!isOwner(session?.user?.id, process.env.OWNER_GITHUB_ID)) redirect("/login");
  return (
    <>
      <nav className="account-bar" aria-label="Account">
        <span>Private workspace · {session?.user?.name ?? "Owner"}</span>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <button type="submit">Sign out</button>
        </form>
      </nav>
      <Miner />
    </>
  );
}
