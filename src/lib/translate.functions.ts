import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { languageLabel, languageScriptNote } from "@/lib/languages";
import type { LanguageCode } from "@/lib/languages";

type AppRole = "arzt" | "patient" | "spectator";

const TranslateInput = z.object({
  text: z.string().min(1),
  direction: z.enum(["forward", "back"]).optional().default("forward"),
});

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

    const { data: langRows, error: langError } = await supabase
      .from("session_language")
      .select("role, language_code");

    if (langError) {
      console.error("[translateText]", langError);
      throw new Error("Sprachen konnten nicht gelesen werden");
    }

    const findCode = (r: "arzt" | "patient") =>
      (langRows?.find((row) => row.role === r)?.language_code ?? null) as LanguageCode | null;

    const myLang = findCode(role);
    const otherLang = findCode(role === "arzt" ? "patient" : "arzt");

    if (!myLang || !otherLang) {
      throw new Error("Sprache noch nicht für beide Seiten ausgewählt");
    }

    const targetCode = data.direction === "forward" ? otherLang : myLang;
    const targetLabel = languageLabel(targetCode);
    const scriptNote = languageScriptNote(targetCode);

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
            content: scriptNote
              ? `Übersetze ins ${targetLabel} (${scriptNote}):\n\n${data.text.trim()}`
              : `Übersetze ins ${targetLabel}:\n\n${data.text.trim()}`,
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
