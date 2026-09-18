import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { AccessToken } from "livekit-server-sdk";

/**
 * Erzeugt einen LiveKit-Zugangs-Token für den angemeldeten Nutzer.
 * Die Rolle wird wie immer serverseitig aus public.user_roles gelesen.
 * Arzt und Patient dürfen Audio publizieren (später: Mikrofon),
 * Zuhörer nur dem Raum beitreten und Streams empfangen.
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

    const canPublish = data.role === "arzt" || data.role === "patient";

    const token = new AccessToken(apiKey, apiSecret, {
      identity: context.userId,
      name: context.userId,
    });

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish,
      canSubscribe: true,
    });

    const jwt = await token.toJwt();

    return { token: jwt, url };
  });
