import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { AccessToken } from "livekit-server-sdk";

/**
 * Erzeugt einen LiveKit-Zugangs-Token für den angemeldeten Nutzer.
 * Alle Rollen (arzt/patient/spectator) dürfen dem Raum beitreten,
 * aber niemand darf Audio/Video veröffentlichen (nur Zuhören/Mitschreiben).
 */
export const getLiveKitToken = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data?.role) throw new Error("Rolle nicht gefunden");

    const apiKey = process.env["LIVEKIT_API_KEY"];
    const apiSecret = process.env["LIVEKIT_API_SECRET"];
    const url = process.env["LIVEKIT_URL"];

    if (!apiKey || !apiSecret || !url) {
      throw new Error("LiveKit ist nicht vollständig konfiguriert");
    }

    const roomName = "medifluent";

    const token = new AccessToken(apiKey, apiSecret, {
      identity: context.userId,
      name: context.userId,
    });

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: false,
      canSubscribe: true,
    });

    const jwt = await token.toJwt();

    return { token: jwt, url };
  });
