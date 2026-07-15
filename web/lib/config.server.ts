import "server-only";

import { loadWebRuntimeConfig } from "@/lib/runtime-config";

export const getDataConfig = () => loadWebRuntimeConfig("data").supabase!;
export const getAuthConfig = () => loadWebRuntimeConfig("auth").auth!;
export const getLLMConfig = () => loadWebRuntimeConfig("llm").deepseek!;
export const getFeedbackConfig = () => loadWebRuntimeConfig("feedback").feedback!;
export const getQuotaConfig = () => loadWebRuntimeConfig("quota").quota!;
