import {
  addAnnotation,
  deleteAnnotation,
  getAnnotations,
  getChats,
  getPaper,
  getTop5,
  listArchive,
  redeemFeedbackToken,
  saveChat,
  saveFeedback,
  searchPapers,
} from "@/lib/data";
import { deepseek } from "@/lib/llm";
import type { OwnerContext } from "@/lib/auth";
import type { VerifiedFeedbackTokenClaims } from "@/lib/feedback-token";

declare const owner: OwnerContext;
declare const itemId: string;
declare const verifiedFeedbackClaims: VerifiedFeedbackTokenClaims;

void getTop5(owner);
void getPaper(owner, itemId);
void listArchive(owner, 10);
void searchPapers(owner, "RAG");
void saveFeedback(owner, itemId, "up");
void redeemFeedbackToken(owner, verifiedFeedbackClaims);
// @ts-expect-error A structurally valid DTO is not a verifier-issued capability.
void redeemFeedbackToken(owner, {
  digestDate: "2026-07-13",
  expiresAt: 1_785_772_800,
  itemId,
  nonce: "A".repeat(43),
  rating: "up",
  version: "v1",
});
void getChats(owner, itemId);
void saveChat(owner, itemId, "user", "question");
void getAnnotations(owner, itemId);
void addAnnotation(owner, itemId, "note", { x: 1, y: 2 }, "#e0c060", "note");
void deleteAnnotation(owner, itemId);
void deepseek(owner);

// @ts-expect-error A service-role read always requires an unforgeable owner capability.
void getTop5();
// @ts-expect-error A plain DTO is not the branded owner capability.
void getPaper({ email: "owner@example.com", userId: itemId }, itemId);
// @ts-expect-error The legacy archive signature cannot bypass owner verification.
void listArchive(10);
// @ts-expect-error Search still reaches the service-role DAL and requires an owner.
void searchPapers("RAG");
// @ts-expect-error Feedback writes cannot use the pre-capability signature.
void saveFeedback(itemId, "up");
// @ts-expect-error Signed feedback redemption still requires the owner capability.
void redeemFeedbackToken({
  digestDate: "2026-07-13",
  expiresAt: 1_785_772_800,
  itemId,
  nonce: "A".repeat(43),
  rating: "up",
  version: "v1",
});
// @ts-expect-error Chat history reads cannot use the pre-capability signature.
void getChats(itemId);
// @ts-expect-error Chat writes cannot use the pre-capability signature.
void saveChat(itemId, "user", "question");
// @ts-expect-error Annotation reads cannot use the pre-capability signature.
void getAnnotations(itemId);
// @ts-expect-error Annotation writes cannot use the pre-capability signature.
void addAnnotation(itemId, "note", { x: 1, y: 2 }, "#e0c060", "note");
// @ts-expect-error Annotation deletes cannot use the pre-capability signature.
void deleteAnnotation(itemId);
// @ts-expect-error LLM cost cannot be triggered without the owner capability.
void deepseek();
