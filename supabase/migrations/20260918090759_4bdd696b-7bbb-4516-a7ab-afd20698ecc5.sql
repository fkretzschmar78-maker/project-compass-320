CREATE TABLE public.session_language (
  role public.app_role PRIMARY KEY,
  language_code text NOT NULL CHECK (language_code IN ('de','en','hi','uk','tr')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.session_language TO authenticated;
GRANT ALL ON public.session_language TO service_role;

ALTER TABLE public.session_language ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Arzt und Patient lesen Sprachen"
ON public.session_language FOR SELECT TO authenticated
USING (has_role(auth.uid(), 'arzt') OR has_role(auth.uid(), 'patient'));

CREATE POLICY "Eigene Sprache anlegen"
ON public.session_language FOR INSERT TO authenticated
WITH CHECK (has_role(auth.uid(), role) AND role IN ('arzt','patient'));

CREATE POLICY "Eigene Sprache aendern"
ON public.session_language FOR UPDATE TO authenticated
USING (has_role(auth.uid(), role) AND role IN ('arzt','patient'))
WITH CHECK (has_role(auth.uid(), role) AND role IN ('arzt','patient'));