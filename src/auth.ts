import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { isOwner } from "./server/access";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub],
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  pages: { signIn: "/login", error: "/login" },
  callbacks: {
    signIn({ account, profile }) {
      return (
        account?.provider === "github" &&
        isOwner(String(profile?.id ?? ""), process.env.OWNER_GITHUB_ID)
      );
    },
    jwt({ token, account, profile }) {
      if (account?.provider === "github") token.ownerId = String(profile?.id ?? "");
      return token;
    },
    session({ session, token }) {
      session.user.id = isOwner(token.ownerId, process.env.OWNER_GITHUB_ID)
        ? String(token.ownerId)
        : "";
      return session;
    },
  },
});
