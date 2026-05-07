import type { RuntimeConfig } from "../types";
import { createPromotionProposal, decidePromotion, mutateState } from "../state";

export async function proposePromotion(config: RuntimeConfig, input: Record<string, unknown>) {
  const candidateRef = String(input.candidateRef ?? "");
  if (!candidateRef) throw new Error("candidateRef is required.");
  return mutateState(config.lane, (state) => createPromotionProposal(state, {
    candidateRef,
    evidencePath: typeof input.evidencePath === "string" && input.evidencePath ? input.evidencePath : undefined,
    summary: String(input.summary ?? "Promotion candidate proposed for review."),
    rollbackPlan: String(input.rollbackPlan ?? "Create a lane snapshot before promotion and restore it if verification fails.")
  }));
}

export async function reviewPromotion(config: RuntimeConfig, promotionId: string, decision: "approve" | "reject") {
  return mutateState(config.lane, (state) => decidePromotion(state, promotionId, decision));
}
