import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type AppRole = "arzt" | "patient" | "spectator";

/** Deepgram-Sprache pro Rolle: arzt=hi (Hindi), patient=de (Deutsch). */
const ROLE_LANGUAGE: Record<Exclude<AppRole, "spectator">, string> = {
  arzt: "hi",
  patient: "de",
};

/**
 * Liefert den Deepgram-Browser-Key fuer die direkte WebSocket-Verbindung.
 * Nur fuer Rollen 'arzt' und 'patient' — Spectators hoeren nur zu
 * und brauchen kein eigenes Mikrofon bzw. Deepgram-Token.
 * Der Browser-Key bleibt serverseitig in process.env und wird nie
 * im Client hartkodiert; er wird nur an authentifizierte 'arzt'/'patient'
 * ausgeliefert.
 */
export const getDeepgramToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const { data: roleRow } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();

    const role = roleRow?.role as AppRole | undefined;
    if (role !== "arzt" && role !== "patient") {
      throw new Error("Forbidden: Rolle 'arzt' oder 'patient' erforderlich");
    }

    const browserKey = process.env["DEEPGRAM_BROWSER_KEY"];
    if (!browserKey) {
      throw new Error("Deepgram Browser-Key ist nicht konfiguriert");
    }

    return {
      token: browserKey,
      model: "nova-3" as const,
      language: ROLE_LANGUAGE[role],
      listenUrl: "wss://api.deepgram.com/v1/listen",
    };
  });
