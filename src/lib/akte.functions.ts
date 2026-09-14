import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type AppRole = "arzt" | "patient" | "spectator";

const SYSTEM_PROMPT = [
  "Du bist ein erfahrener klinischer Dokumentationsassistent.",
  "",
  "Erhalte das folgende Gesprächsprotokoll zwischen Arzt und Patient und erzeuge daraus eine deutsche klinische Aktennotiz.",
  "",
  "Gib ausschließlich ein gültiges JSON-Objekt zurück. Füge keine Markdown-Formatierung, keine Code-Blöcke, keine Einleitung und keine Erläuterungen hinzu.",
  "Das JSON-Objekt muss genau diese vier Schlüssel enthalten: anamnese, befund, beurteilung, prozedere.",
  "Jeder Wert muss ein einzelner Fließtext-String sein. Vermeide Aufzählungen oder strukturierte Listen innerhalb der Strings. Benutze ganze Sätze und Fließtext.",
  "",
  "Anamnese: Weshalb sucht der Patient auf? Was schildert er? Relevante Vorgeschichte, Medikation, Allergien, soziale Situation.",
  "Befund: Objektive Befunde aus der Untersuchung, Vitalparameter, Labor-/Bildgebungsergebnisse, Messwerte.",
  "Beurteilung: Zusammenfassende Einordnung, mögliche Diagnosen, Differenzialdiagnosen, Einschätzung des Schweregrads.",
  "Prozedere: Weiteres Vorgehen, geplante Untersuchungen, Therapie, Beratung, Terminvereinbarungen, Patientenaufklärung.",
  "",
  "Falls der Verlauf zu wenig Informationen für einen Abschnitt enthält, gib für diesen Schlüssel einen kurzen, sachlichen Hinweis im Fließtext zurück (z. B. \"Nicht ausreichend dokumentiert\").",
].join("\n");

type Akte = {
  anamnese: string;
  befund: string;
  beurteilung: string;
  prozedere: string;
};

export const generateAkte = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const { data: roleRow } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();

    const role = roleRow?.role as AppRole | undefined;

    if (role !== "arzt") {
      throw new Error("Forbidden: Nur Rolle 'arzt' darf eine Akte erstellen");
    }

    const { data: logs, error: logError } = await supabase
      .from("conversation_log")
      .select("role, text, source, created_at")
      .order("created_at", { ascending: true });

    if (logError) {
      console.error("[generateAkte] Fehler beim Lesen des Gesprächsverlaufs:", logError);
      throw new Error("Gesprächsverlauf konnte nicht gelesen werden");
    }

    if (!logs || logs.length === 0) {
      throw new Error("Kein Gesprächsverlauf vorhanden");
    }

    const verlauf = logs.map((entry) => ({
      role: entry.role,
      text: entry.text,
      source: entry.source,
      created_at: entry.created_at,
    }));

    const protocol = verlauf
      .map((entry) => {
        const speaker =
          entry.role === "patient"
            ? "Patient"
            : entry.role === "arzt"
              ? "Arzt"
              : "Unbekannt";
        return `${speaker}: ${entry.text}`;
      })
      .join("\n\n");

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
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Gesprächsprotokoll:\n\n${protocol}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[generateAkte] OpenAI-Fehler ${response.status}:`, body);
      throw new Error("Aktennotiz konnte nicht erstellt werden");
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = json.choices?.[0]?.message?.content?.trim();

    if (!content) {
      throw new Error("OpenAI hat keine Aktennotiz zurückgegeben");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      console.error("[generateAkte] Ungültiges JSON von OpenAI:", content, err);
      throw new Error("Aktennotiz konnte nicht verarbeitet werden");
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("anamnese" in parsed) ||
      !("befund" in parsed) ||
      !("beurteilung" in parsed) ||
      !("prozedere" in parsed)
    ) {
      console.error("[generateAkte] JSON-Antwort unvollständig:", parsed);
      throw new Error("Aktennotiz enthält nicht alle erforderlichen Abschnitte");
    }

    const akte = parsed as Akte;

    return { akte, verlauf };
  });
