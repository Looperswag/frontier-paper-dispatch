import { createServer } from "node:http";
import process from "node:process";

const port = Number(process.argv[2] ?? 54329);
const itemId = "00000000-0000-4000-8000-000000000001";
const ownerId = "00000000-0000-4000-8000-000000000701";
const ownerEmail = "owner@example.com";
const ownerPassword = "e2e-private-password-with-entropy";
const serviceRoleKey = `sb_secret_${"e".repeat(40)}`;
const issuedAccessTokens = new Set();
let tokenSequence = 0;

const item = {
  abstract: "A deterministic abstract used only by browser tests.",
  authors: ["Test Author"],
  external_id: "test-001",
  id: itemId,
  published_at: "2026-07-10T00:00:00.000Z",
  signals: {},
  source: "test",
  title: "Deterministic Test Paper",
  url: "https://example.com/test-paper",
};

const summary = {
  created_at: "2026-07-10T00:00:00.000Z",
  id: "00000000-0000-4000-8000-000000000002",
  impact_md: "Deterministic impact.",
  item_id: itemId,
  one_liner: "A deterministic one-line summary.",
  rank: 1,
  score: 100,
  summary_md: "Deterministic summary.",
};

const owner = {
  aud: "authenticated",
  created_at: "2026-07-12T01:00:00Z",
  email: ownerEmail,
  email_confirmed_at: "2026-07-12T01:00:00Z",
  id: ownerId,
  is_anonymous: false,
  role: "authenticated",
};

function token(sequence) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({
      aud: "authenticated",
      email: ownerEmail,
      exp: Math.floor(Date.now() / 1000) + 3600,
      is_anonymous: false,
      jti: `e2e-${sequence}`,
      role: "authenticated",
      sub: ownerId,
    }),
    Buffer.from(`e2e-signature-${sequence}`).toString("base64url"),
  ].join(".");
}

async function requestJSON(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw new Error("test request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response, value, status = 200) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function issuedBearer(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return undefined;
  }
  const accessToken = authorization.slice("Bearer ".length);
  return issuedAccessTokens.has(accessToken) ? accessToken : undefined;
}

function serviceRoleAuthorized(request) {
  return (
    request.headers.apikey === serviceRoleKey &&
    request.headers.authorization === `Bearer ${serviceRoleKey}`
  );
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/health") {
      json(response, { ok: true });
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/auth/v1/token" &&
      url.searchParams.get("grant_type") === "password"
    ) {
      const credentials = await requestJSON(request);
      if (credentials.email !== ownerEmail || credentials.password !== ownerPassword) {
        json(
          response,
          { code: "invalid_credentials", msg: "test credentials rejected" },
          400,
        );
        return;
      }
      tokenSequence += 1;
      const accessToken = token(tokenSequence);
      issuedAccessTokens.add(accessToken);
      json(response, {
        access_token: accessToken,
        expires_in: 3600,
        refresh_token: `e2e-refresh-token-${tokenSequence}`,
        token_type: "bearer",
        user: owner,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/auth/v1/user") {
      if (!issuedBearer(request)) {
        json(response, { code: "bad_jwt", msg: "test token rejected" }, 401);
        return;
      }
      json(response, owner);
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/v1/logout") {
      const accessToken = issuedBearer(request);
      if (!accessToken) {
        json(response, { code: "bad_jwt", msg: "test token rejected" }, 401);
        return;
      }
      issuedAccessTokens.delete(accessToken);
      response.writeHead(204);
      response.end();
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/rest/v1/rpc/get_latest_digest_bundle"
    ) {
      if (!serviceRoleAuthorized(request)) {
        json(response, { code: "bad_jwt", message: "test service role rejected" }, 401);
        return;
      }
      json(response, [
        {
          digest_date: "2026-07-10",
          papers: [{ ...summary, ...item, rating: null }],
          top5_item_ids: [itemId],
        },
      ]);
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/rest/v1/rpc/consume_api_rate_limits"
    ) {
      if (!serviceRoleAuthorized(request)) {
        json(response, { code: "bad_jwt", message: "test service role rejected" }, 401);
        return;
      }
      json(response, [{ outcome: "allowed", reset_at: null, retry_after_seconds: null }]);
      return;
    }

    const table = url.pathname.match(/^\/rest\/v1\/([^/]+)$/)?.[1];
    if (table && !serviceRoleAuthorized(request)) {
      json(response, { code: "bad_jwt", message: "test service role rejected" }, 401);
      return;
    }
    switch (table) {
      case "digests":
        json(response, { digest_date: "2026-07-10", top5_item_ids: [itemId] });
        return;
      case "feedback":
        json(response, []);
        return;
      case "items":
        json(response, [item]);
        return;
      case "summaries":
        json(response, [summary]);
        return;
      default:
        json(response, []);
    }
  } catch {
    json(response, { message: "test service failure" }, 500);
  }
});

server.listen(port, "127.0.0.1");

function close() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
