import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { LanguageCode } from "@/lib/languages";

type AppRole = "arzt" | "patient" | "spectator";

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

    const { data: langRow, error: langError } = await supabase
      .from("session_language")
      .select("language_code")
      .eq("role", role)
      .maybeSingle();

    if (langError) {
      console.error("[getDeepgramToken]", langError);
      throw new Error("Sprache konnte nicht gelesen werden");
    }

    if (!langRow?.language_code) {
      throw new Error("Bitte zuerst eine Sprache auswählen");
    }

    const browserKey = process.env["DEEPGRAM_BROWSER_KEY"];
    if (!browserKey) {
      throw new Error("Deepgram Browser-Key ist nicht konfiguriert");
    }

    return {
      token: browserKey,
      model: "nova-3" as const,
      language: langRow.language_code as LanguageCode,
      listenUrl: "wss://api.deepgram.com/v1/listen",
    };
  });
