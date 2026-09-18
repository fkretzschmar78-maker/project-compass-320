/** Zentrale Sprachliste — einzige Quelle der Wahrheit fuer die App. */
export const LANGUAGES = [
  { code: "de", label: "Deutsch" },
  { code: "en", label: "Englisch" },
  { code: "hi", label: "Hindi", scriptNote: "in Devanagari-Schrift, nicht in lateinischer Umschrift" },
  { code: "uk", label: "Ukrainisch", scriptNote: "in kyrillischer Schrift, nicht in lateinischer Umschrift" },
  { code: "tr", label: "Türkisch" },
] as const;

export type Language = (typeof LANGUAGES)[number];
export type LanguageCode = Language["code"];

export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code) as readonly LanguageCode[];

export function isLanguageCode(value: string): value is LanguageCode {
  return (LANGUAGE_CODES as readonly string[]).includes(value);
}

export function languageLabel(code: LanguageCode): string {
  return LANGUAGES.find((l) => l.code === code)!.label;
}

export function languageScriptNote(code: LanguageCode): string | undefined {
  return LANGUAGES.find((l) => l.code === code)?.scriptNote;
}
