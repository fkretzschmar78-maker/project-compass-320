import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type AppRole = "arzt" | "patient" | "spectator";

/**
 * Liest die Rolle des angemeldeten Nutzers. Die Rolle stammt ausschliesslich
 * aus public.user_roles und kann vom Client nicht gesetzt werden.
 */
export const getMyRole = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(error.message);

    const email =
      typeof context.claims?.["email"] === "string"
        ? (context.claims["email"] as string)
        : null;

    return { role: (data?.role ?? null) as AppRole | null, email };
  });

/**
 * Gleicht die E-Mail des angemeldeten Nutzers erneut gegen die Whitelist ab.
 * Noetig, wenn die Whitelist erst nach der Registrierung gepflegt wurde.
 * Die Rolle kommt dabei nur aus der Tabelle, nie aus Client-Eingaben.
 */
export const syncMyRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const email =
      typeof context.claims?.["email"] === "string"
        ? (context.claims["email"] as string).toLowerCase()
        : null;

    if (!email) return { role: null as AppRole | null };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: entry, error: whitelistError } = await supabaseAdmin
      .from("role_whitelist")
      .select("role")
      .eq("email", email)
      .maybeSingle();

    if (whitelistError) throw new Error(whitelistError.message);
    if (!entry) return { role: null as AppRole | null };

    const { error: deleteError } = await supabaseAdmin
      .from("user_roles")
      .delete()
      .eq("user_id", context.userId)
      .neq("role", entry.role);

    if (deleteError) throw new Error(deleteError.message);

    const { error: insertError } = await supabaseAdmin
      .from("user_roles")
      .upsert(
        { user_id: context.userId, role: entry.role },
        { onConflict: "user_id,role" },
      );

    if (insertError) throw new Error(insertError.message);

    return { role: entry.role as AppRole };
  });
