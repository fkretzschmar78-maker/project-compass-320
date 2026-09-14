import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type AppRole = "arzt" | "patient" | "spectator";

/** Deepgram-Sprache pro Rolle: arzt=hi (Hindi), patient=de (Deutsch). */
const ROLE_LANGUAGE: Record<Exclude<AppRole, "spectator">, string> = {
  arzt: "hi",
  patient: "de",
};

/**
 * Stellt ein kurzlebiges Deepgram-Temporary-Token aus.
 * Nur fuer Rollen 'arzt' und 'patient' — Spectators hoeren nur zu
 * und brauchen kein eigenes Mikrofon bzw. Deepgram-Token.
 * Der echte Deepgram-API-Key bleibt serverseitig (process.env),
 * der Client erhaelt nur das kurzlebige Token und verbindet sich
 * anschliessend direkt mit wss://api.deepgram.com/v1/listen.
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

    const apiKey = process.env["DEEPGRAM_API_KEY"];
    if (!apiKey) {
      throw new Error("Deepgram API-Key ist nicht konfiguriert");
    }

    const response = await fetch("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl_seconds: 60 }),
    });

    if (!response.ok) {
      throw new Error(`Deepgram-Tokenanforderung fehlgeschlagen (${response.status})`);
    }

    const grant = (await response.json()) as { access_token?: string };
    if (!grant.access_token) {
      throw new Error("Deepgram hat kein Token zurueckgegeben");
    }

    return {
      token: grant.access_token,
      model: "nova-3" as const,
      language: ROLE_LANGUAGE[role],
      listenUrl: "wss://api.deepgram.com/v1/listen",
    };
  });
