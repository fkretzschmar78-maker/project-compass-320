import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

type AppRole = "arzt" | "patient" | "spectator";
type SpeakerRole = "arzt" | "patient";

const LogInput = z.object({ text: z.string().min(1) });

// source wird ausschliesslich serverseitig aus der Rolle abgeleitet.
const ROLE_SOURCE: Record<SpeakerRole, "original" | "translated"> = {
  patient: "original",
  arzt: "translated",
};

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

export const logConversationSegment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => LogInput.parse(input))
  .handler(async ({ data, context }) => {
    const role = await requireSpeakerRole(context.supabase, context.userId);

    const { error } = await context.supabase.from("conversation_log").insert({
      role,
      text: data.text.trim(),
      source: ROLE_SOURCE[role],
    });

    if (error) {
      console.error("[logConversationSegment]", error);
      throw new Error("Eintrag konnte nicht gespeichert werden");
    }

    return { ok: true as const };
  });

export const clearConversationLog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireSpeakerRole(context.supabase, context.userId);

    const { error } = await context.supabase
      .from("conversation_log")
      .delete()
      .not("id", "is", null);

    if (error) {
      console.error("[clearConversationLog]", error);
      throw new Error("Log konnte nicht geleert werden");
    }

    return { ok: true as const };
  });
