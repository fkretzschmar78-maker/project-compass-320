import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/languages";

type AppRole = "arzt" | "patient" | "spectator";
type SpeakerRole = "arzt" | "patient";

const LanguageInput = z.object({
  languageCode: z.enum(LANGUAGE_CODES as unknown as [LanguageCode, ...LanguageCode[]]),
});

async function requireSpeakerRole(
  supabase: { from: (table: string) => any },
  userId: string,
): Promise<SpeakerRole> {
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();

  const role = data?.role as AppRole | undefined;
  if (role !== "arzt" && role !== "patient") {
    throw new Error("Forbidden: Rolle 'arzt' oder 'patient' erforderlich");
  }
  return role;
}

export const setMyLanguage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => LanguageInput.parse(input))
  .handler(async ({ data, context }) => {
    const role = await requireSpeakerRole(context.supabase, context.userId);

    const { error } = await context.supabase
      .from("session_language")
      .upsert(
        { role, language_code: data.languageCode, updated_at: new Date().toISOString() },
        { onConflict: "role" },
      );

    if (error) {
      console.error("[setMyLanguage]", error);
      throw new Error("Sprache konnte nicht gespeichert werden");
    }

    return { role, languageCode: data.languageCode as LanguageCode };
  });

export const getSessionLanguages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireSpeakerRole(context.supabase, context.userId);

    const { data, error } = await context.supabase
      .from("session_language")
      .select("role, language_code");

    if (error) {
      console.error("[getSessionLanguages]", error);
      throw new Error("Sprachen konnten nicht gelesen werden");
    }

    const find = (r: SpeakerRole) =>
      (data?.find((row) => row.role === r)?.language_code ?? null) as LanguageCode | null;

    return { arzt: find("arzt"), patient: find("patient") };
  });
