export type APIMutationBoundary =
  | "caller_session_logout"
  | "owner_business"
  | "owner_password_login";

export type APIMutationInventoryEntry = Readonly<{
  boundary: APIMutationBoundary;
  id: string;
  method: "DELETE" | "PATCH" | "POST" | "PUT";
  path: `/api/${string}`;
}>;

export const API_MUTATION_INVENTORY: readonly APIMutationInventoryEntry[] =
  Object.freeze([
    Object.freeze({
      boundary: "owner_business",
      id: "annotations.create",
      method: "POST",
      path: "/api/annotations",
    }),
    Object.freeze({
      boundary: "owner_business",
      id: "annotations.delete",
      method: "DELETE",
      path: "/api/annotations",
    }),
    Object.freeze({
      boundary: "owner_business",
      id: "chat.create",
      method: "POST",
      path: "/api/chat",
    }),
    Object.freeze({
      boundary: "owner_business",
      id: "feedback.create",
      method: "POST",
      path: "/api/feedback",
    }),
    Object.freeze({
      boundary: "owner_business",
      id: "feedback.redeem",
      method: "POST",
      path: "/api/feedback/redeem",
    }),
    Object.freeze({
      boundary: "owner_password_login",
      id: "auth.login",
      method: "POST",
      path: "/api/auth/login",
    }),
    Object.freeze({
      boundary: "caller_session_logout",
      id: "auth.logout",
      method: "POST",
      path: "/api/auth/logout",
    }),
  ]);
