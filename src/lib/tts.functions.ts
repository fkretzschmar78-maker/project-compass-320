import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

type AppRole = "arzt" | "patient" | "spectator";

const SynthesizeInput = z.object({ text: z.string().min(1) });

/** Satzaufteilung an . ! ? sowie dem Devanagari-Satzzeichen । (Danda). */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?।])\s+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const synthesizeSpeech = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => SynthesizeInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: roleRow } = await supabase.from("user_roles")
      .select("role").eq("user_id", userId).maybeSingle();
    const role = roleRow?.role as AppRole | undefined;
    if (role !== "arzt" && role !== "patient") {
      throw new Error("Forbidden: Rolle 'arzt' oder 'patient' erforderlich");
    }

    const apiKey = process.env["OPENAI_API_KEY"];
    if (!apiKey) throw new Error("OpenAI API-Key ist nicht konfiguriert");

    const sentences = splitSentences(data.text.trim());
    if (sentences.length === 0) throw new Error("Kein Text zum Synthetisieren");

    const clips = await Promise.all(
      sentences.map(async (sentence) => {
        const response = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "tts-1",
            voice: "alloy",
            response_format: "mp3",
            input: sentence,
          }),
        });

        if (!response.ok) {
          const body = await response.text();
          console.error(`[synthesizeSpeech] OpenAI-Fehler ${response.status}:`, body);
          throw new Error("Sprachausgabe konnte nicht erstellt werden");
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        return buffer.toString("base64");
      }),
    );

    return { clips }; // Base64-MP3s in Satzreihenfolge
  });
