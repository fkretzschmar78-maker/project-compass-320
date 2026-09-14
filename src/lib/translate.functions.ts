import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

type AppRole = "arzt" | "patient" | "spectator";

const TranslateInput = z.object({
  text: z.string().min(1),
  direction: z.enum(["forward", "back"]).optional().default("forward"),
});

const ROLE_LANGUAGES: Record<
  Exclude<AppRole, "spectator">,
  { forward: { code: string; label: string }; back: { code: string; label: string } }
> = {
  arzt: {
    forward: { code: "de", label: "Deutsche" },
    back: { code: "hi", label: "Hindi (Devanagari)" },
  },
  patient: {
    forward: { code: "hi", label: "Hindi (Devanagari)" },
    back: { code: "de", label: "Deutsche" },
  },
};

const SYSTEM_PROMPT = [
  "Ausschließlich die Übersetzung zurückgeben, ohne Einleitung oder Kommentare.",
  "",
  "Zahlen, Dosierungen (mg, ml, Tabletten) und Zeitangaben absolut exakt beibehalten.",
  "",
  "Bei unsicherer medizinischer Nomenklatur die klinisch präziseste Alltagsübersetzung verwenden.",
].join("\n");

export const translateText = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => TranslateInput.parse(input))
  .handler(async ({ data, context }) => {
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

    const target = ROLE_LANGUAGES[role][data.direction];
    const apiKey = process.env["OPENAI_API_KEY"];

    if (!apiKey) {
      throw new Error("OpenAI API-Key ist nicht konfiguriert");
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Übersetze ins ${target.label}:\n\n${data.text.trim()}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[translateText] OpenAI-Fehler ${response.status}:`, body);
      throw new Error("Übersetzung konnte nicht erstellt werden");
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const translation = json.choices?.[0]?.message?.content?.trim();

    if (!translation) {
      throw new Error("OpenAI hat keine Übersetzung zurückgegeben");
    }

    return { translation };
  });
