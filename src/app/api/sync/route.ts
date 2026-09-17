import { auth } from "../../../auth";
import { isOwner, isSameOrigin } from "../../../server/access";
import { StoreError } from "../../../server/storage/validation";
import { dispatchSyncOperation } from "../../../server/sync";

export const runtime = "nodejs";
export const maxDuration = 60;
const MAX_BODY_BYTES = 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  const session = await auth();
  if (!isOwner(session?.user?.id, process.env.OWNER_GITHUB_ID)) {
    return Response.json({ error: "Please sign in with the owner account." }, { status: 401 });
  }
  // Next's internal request URL can use localhost behind a proxy. The configured
  // public auth URL is the authoritative origin; never trust forwarded headers.
  if (!isSameOrigin(request.headers.get("origin"), process.env.AUTH_URL ?? request.url)) {
    return Response.json({ error: "Request origin rejected." }, { status: 403 });
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return Response.json({ error: "Expected JSON." }, { status: 415 });
  }
  try {
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: "Missing request body." }, { status: 400 });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return Response.json({ error: "Upload batch is too large." }, { status: 413 });
      }
      chunks.push(part.value);
    }
    const body = Buffer.concat(chunks);
    const input: unknown = JSON.parse(body.toString("utf8"));
    const result = await dispatchSyncOperation(input);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    if (error instanceof StoreError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    }
    if (error instanceof SyntaxError)
      return Response.json({ error: "Invalid JSON." }, { status: 400 });
    console.error(
      "Sync operation failed",
      error instanceof Error ? error.name : "Unknown error",
    );
    return Response.json(
      { error: "Database sync operation could not be confirmed. Try again later." },
      { status: 503 },
    );
  }
}
