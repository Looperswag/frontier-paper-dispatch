import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import {
  createClient,
  type Session,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import { expect, test, type APIResponse, type BrowserContext } from "@playwright/test";
import { issueFeedbackToken } from "../../lib/feedback-token";
import { authStorageKey } from "../lib/auth-cookie";
import { API_MUTATION_INVENTORY } from "../test/api-mutation-inventory";
import {
  EXISTING_ANNOTATION_ID,
  EXISTING_ITEM_ID,
  NON_OWNER_EMAIL,
  NON_OWNER_PASSWORD,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  REAL_IDOR_BASE_URL,
  REAL_IDOR_FEEDBACK_SECRET,
  TRUSTED_TEST_IP,
} from "../test/real-idor-fixtures";

const SNAPSHOT_TABLES = Object.freeze([
  "annotations",
  "api_rate_limit_buckets",
  "chats",
  "feedback",
  "feedback_token_redemptions",
  "llm_budget_days",
  "llm_budget_reservations",
] as const);

const SNAPSHOT_SQL = String.raw`
select jsonb_build_object(
  'annotations', coalesce((
    select jsonb_agg(to_jsonb(row_value) order by row_value.id)
    from public.annotations as row_value
  ), '[]'::jsonb),
  'api_rate_limit_buckets', coalesce((
    select jsonb_agg(to_jsonb(row_value) order by row_value.policy, row_value.dimension, row_value.subject)
    from public.api_rate_limit_buckets as row_value
  ), '[]'::jsonb),
  'chats', coalesce((
    select jsonb_agg(to_jsonb(row_value) order by row_value.id)
    from public.chats as row_value
  ), '[]'::jsonb),
  'feedback', coalesce((
    select jsonb_agg(to_jsonb(row_value) order by row_value.id)
    from public.feedback as row_value
  ), '[]'::jsonb),
  'feedback_token_redemptions', coalesce((
    select jsonb_agg(to_jsonb(row_value) order by row_value.nonce_hash)
    from public.feedback_token_redemptions as row_value
  ), '[]'::jsonb),
  'llm_budget_days', coalesce((
    select jsonb_agg(to_jsonb(row_value) order by row_value.budget_date, row_value.dimension, row_value.subject)
    from public.llm_budget_days as row_value
  ), '[]'::jsonb),
  'llm_budget_reservations', coalesce((
    select jsonb_agg(to_jsonb(row_value) order by row_value.id)
    from public.llm_budget_reservations as row_value
  ), '[]'::jsonb)
)::text;
`;

type SnapshotDocument = Readonly<
  Record<(typeof SNAPSHOT_TABLES)[number], readonly unknown[]>
>;
type MutationCase = Readonly<{
  id: string;
  invoke: (context: BrowserContext) => Promise<APIResponse>;
}>;

let admin: SupabaseClient;
let ownerSession: Session;
let nonOwnerSession: Session;
let redemptionToken: string;
let testDigestDate: string;
let ownerUserId: string | undefined;
let nonOwnerUserId: string | undefined;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing real IDOR test environment: ${name}`);
  return value;
}

function shanghaiDate(offsetDays = 0): string {
  const shifted = new Date(Date.now() + offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Shanghai",
    year: "numeric",
  }).formatToParts(shifted);
  const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${value.year}-${value.month}-${value.day}`;
}

function sessionCookie(session: Session): { name: string; url: string; value: string } {
  const encoded = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return {
    name: authStorageKey(requiredEnvironment("SUPABASE_URL")),
    url: REAL_IDOR_BASE_URL,
    value: `base64-${encoded}`,
  };
}

async function installSession(context: BrowserContext, session: Session): Promise<void> {
  await context.addCookies([sessionCookie(session)]);
}

function databaseSnapshot(): string {
  const container = requiredEnvironment("SUPABASE_DB_CONTAINER");
  const output = execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      "PGOPTIONS=-c statement_timeout=10000",
      container,
      "psql",
      "-X",
      "-q",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-c",
      SNAPSHOT_SQL,
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 15_000 },
  ).trim();
  const parsed = JSON.parse(output) as SnapshotDocument;
  expect(Object.keys(parsed).sort()).toEqual([...SNAPSHOT_TABLES].sort());
  for (const table of SNAPSHOT_TABLES) expect(Array.isArray(parsed[table])).toBe(true);
  return output;
}

function insertAuthSession(userId: string): string {
  const sessionId = randomUUID();
  const container = requiredEnvironment("SUPABASE_DB_CONTAINER");
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      "PGOPTIONS=-c statement_timeout=10000",
      container,
      "psql",
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      `fixture_user_id=${userId}`,
      "-v",
      `fixture_session_id=${sessionId}`,
      "-U",
      "postgres",
      "-d",
      "postgres",
    ],
    {
      encoding: "utf8",
      input: String.raw`
insert into auth.sessions (
  id, user_id, created_at, updated_at, aal, not_after, refreshed_at,
  user_agent, ip
) values (
  :'fixture_session_id'::uuid,
  :'fixture_user_id'::uuid,
  clock_timestamp(),
  clock_timestamp(),
  'aal1'::auth.aal_level,
  clock_timestamp() + interval '1 hour',
  clock_timestamp(),
  'frontier-real-idor-acceptance',
  '127.0.0.1'::inet
);
`,
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
    },
  );
  return sessionId;
}

function prepareFeedbackDigest(digestDate: string): void {
  const container = requiredEnvironment("SUPABASE_DB_CONTAINER");
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      "PGOPTIONS=-c statement_timeout=10000",
      container,
      "psql",
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      `fixture_digest_date=${digestDate}`,
      "-v",
      `fixture_item_id=${EXISTING_ITEM_ID}`,
      "-U",
      "postgres",
      "-d",
      "postgres",
    ],
    {
      encoding: "utf8",
      input: String.raw`
insert into public.digests (digest_date, top5_item_ids, rendered_md)
values (
  :'fixture_digest_date'::date,
  array[:'fixture_item_id'::uuid],
  '# Real IDOR acceptance fixture'
);
`,
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
    },
  );
}

function removeFeedbackDigest(digestDate: string): void {
  const container = requiredEnvironment("SUPABASE_DB_CONTAINER");
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      "PGOPTIONS=-c statement_timeout=10000",
      container,
      "psql",
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      `fixture_digest_date=${digestDate}`,
      "-U",
      "postgres",
      "-d",
      "postgres",
    ],
    {
      encoding: "utf8",
      input: "delete from public.digests where digest_date = :'fixture_digest_date'::date;\n",
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
    },
  );
}

function accessToken(user: User, sessionId: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    aal: "aal1",
    app_metadata: user.app_metadata,
    aud: "authenticated",
    email: user.email,
    exp: now + 3_600,
    iat: now,
    is_anonymous: false,
    iss: `${requiredEnvironment("SUPABASE_URL")}/auth/v1`,
    role: "authenticated",
    session_id: sessionId,
    sub: user.id,
    user_metadata: user.user_metadata,
  })}`;
  const signature = createHmac("sha256", requiredEnvironment("IDOR_JWT_SECRET"))
    .update(unsigned)
    .digest("base64url");
  return `${unsigned}.${signature}`;
}

function createFixtureSession(user: User): Session {
  const sessionId = insertAuthSession(user.id);
  return {
    access_token: accessToken(user, sessionId),
    expires_at: Math.floor(Date.now() / 1_000) + 3_600,
    expires_in: 3_600,
    refresh_token: `idor-refresh-${randomUUID()}`,
    token_type: "bearer",
    user,
  };
}

async function createFixtureUser(email: string, password: string): Promise<User> {
  const result = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password,
  });
  expect(result.error).toBeNull();
  expect(result.data.user?.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  return result.data.user!;
}

async function setupIdentitiesAndToken(): Promise<void> {
  admin = createClient(
    requiredEnvironment("SUPABASE_URL"),
    requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const ownerUser = await createFixtureUser(OWNER_EMAIL, OWNER_PASSWORD);
  const nonOwnerUser = await createFixtureUser(NON_OWNER_EMAIL, NON_OWNER_PASSWORD);
  ownerUserId = ownerUser.id;
  nonOwnerUserId = nonOwnerUser.id;
  ownerSession = createFixtureSession(ownerUser);
  nonOwnerSession = createFixtureSession(nonOwnerUser);

  testDigestDate = shanghaiDate(365);
  prepareFeedbackDigest(testDigestDate);
  redemptionToken = issueFeedbackToken(REAL_IDOR_FEEDBACK_SECRET, {
    digestDate: testDigestDate,
    itemId: EXISTING_ITEM_ID,
    rating: "down",
  });
}

async function cleanupIdentitiesAndToken(): Promise<void> {
  if (!admin) return;
  if (testDigestDate) removeFeedbackDigest(testDigestDate);
  const userIds = [ownerUserId, nonOwnerUserId].filter(
    (value): value is string => value !== undefined,
  );
  if (userIds.length === 0) return;
  const container = requiredEnvironment("SUPABASE_DB_CONTAINER");
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      "PGOPTIONS=-c statement_timeout=10000",
      container,
      "psql",
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      `fixture_user_ids=${userIds.join(",")}`,
      "-U",
      "postgres",
      "-d",
      "postgres",
    ],
    {
      encoding: "utf8",
      input:
        "delete from auth.users where id = any(string_to_array(:'fixture_user_ids', ',')::uuid[]);\n",
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
    },
  );
}

const mutationCases: readonly MutationCase[] = [
  {
    id: "annotations.create",
    invoke: (context) =>
      context.request.post("/api/annotations", {
        data: {
          anchor: { x: 0.125, y: 0.75 },
          body: "non-owner must never persist this annotation",
          itemId: EXISTING_ITEM_ID,
          type: "note",
        },
        headers: { Origin: REAL_IDOR_BASE_URL },
      }),
  },
  {
    id: "annotations.delete",
    invoke: (context) =>
      context.request.delete(`/api/annotations?id=${EXISTING_ANNOTATION_ID}`, {
        headers: { Origin: REAL_IDOR_BASE_URL },
      }),
  },
  {
    id: "chat.create",
    invoke: (context) =>
      context.request.post("/api/chat", {
        data: { itemId: EXISTING_ITEM_ID, message: "non-owner chat mutation" },
        headers: { Origin: REAL_IDOR_BASE_URL },
        timeout: 15_000,
      }),
  },
  {
    id: "feedback.create",
    invoke: (context) =>
      context.request.post("/api/feedback", {
        data: {
          itemId: EXISTING_ITEM_ID,
          note: "non-owner feedback mutation",
          rating: "down",
        },
        headers: { Origin: REAL_IDOR_BASE_URL },
      }),
  },
  {
    id: "feedback.redeem",
    invoke: (context) =>
      context.request.post("/api/feedback/redeem", {
        data: { token: redemptionToken },
        headers: { Origin: REAL_IDOR_BASE_URL },
      }),
  },
];

test.describe.configure({ mode: "serial" });
test.beforeAll(setupIdentitiesAndToken);
test.afterAll(cleanupIdentitiesAndToken);

test("real matrix covers every owner-business mutation in the contract", () => {
  const expected = API_MUTATION_INVENTORY.filter(
    ({ boundary }) => boundary === "owner_business",
  ).map(({ id }) => id).sort();
  expect(mutationCases.map(({ id }) => id).sort()).toEqual(expected);
});

for (const mutation of mutationCases) {
  test(`${mutation.id}: a real non-owner gets 403 and all seven tables stay byte-stable`, async ({
    context,
  }) => {
    await installSession(context, nonOwnerSession);
    const before = databaseSnapshot();

    const response = await mutation.invoke(context);

    expect(response.status()).toBe(403);
    expect(await response.text()).toBe("Access forbidden");
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(databaseSnapshot()).toBe(before);
  });
}

test("login accepts no attacker-selected identity or non-owner password", async ({
  context,
}) => {
  const attackerSelected = await context.request.post("/api/auth/login", {
    form: { email: NON_OWNER_EMAIL, password: NON_OWNER_PASSWORD },
    headers: { Origin: REAL_IDOR_BASE_URL },
  });
  expect(attackerSelected.status()).toBe(400);

  const rejected = await context.request.post("/api/auth/login", {
    form: { password: NON_OWNER_PASSWORD },
    headers: { Origin: REAL_IDOR_BASE_URL },
  });
  // Local Auth keeps the email provider disabled as a second signup boundary,
  // so a password that belongs to another real identity fails closed before
  // any owner session can be issued.
  expect(rejected.status()).toBe(503);
  expect(await rejected.text()).toBe("Authentication unavailable");
  expect((await context.cookies()).some(({ name }) => name.endsWith("-auth-token"))).toBe(
    false,
  );

  await installSession(context, ownerSession);
  const ownerRead = await context.request.get(
    `/api/annotations?itemId=${EXISTING_ITEM_ID}`,
  );
  expect(ownerRead.status()).toBe(200);
});

test("logout clears only its caller session and leaves an independent owner session valid", async ({
  browser,
  context,
}) => {
  await installSession(context, nonOwnerSession);
  const ownerContext = await browser.newContext({
    baseURL: REAL_IDOR_BASE_URL,
    extraHTTPHeaders: { "x-vercel-forwarded-for": TRUSTED_TEST_IP },
  });
  try {
    await installSession(ownerContext, ownerSession);
    const before = databaseSnapshot();

    const response = await context.request.post("/api/auth/logout", {
      headers: { Origin: REAL_IDOR_BASE_URL },
      maxRedirects: 0,
    });

    expect(response.status()).toBe(303);
    expect((await context.cookies()).some(({ name }) => name.endsWith("-auth-token"))).toBe(
      false,
    );
    expect(
      (
        await context.request.get(`/api/annotations?itemId=${EXISTING_ITEM_ID}`)
      ).status(),
    ).toBe(401);
    expect(
      (
        await ownerContext.request.get(`/api/annotations?itemId=${EXISTING_ITEM_ID}`)
      ).status(),
    ).toBe(200);
    expect(databaseSnapshot()).toBe(before);
  } finally {
    await ownerContext.close();
  }
});
