import "@testing-library/jest-dom/vitest";

process.env.SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= `sb_secret_${"t".repeat(40)}`;
process.env.DEEPSEEK_API_KEY ??= `sk-${"t".repeat(40)}`;
