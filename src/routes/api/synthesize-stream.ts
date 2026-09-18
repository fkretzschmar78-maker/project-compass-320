import { createFileRoute } from '@tanstack/react-router'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/integrations/supabase/types'

function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith('sb_publishable_') || value.startsWith('sb_secret_');
}

function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined,
    );

    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }

    if (isNewSupabaseApiKey(supabaseKey) && headers.get('Authorization') === `Bearer ${supabaseKey}`) {
      headers.delete('Authorization');
    }

    headers.set('apikey', supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

export const Route = createFileRoute('/api/synthesize-stream')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const SUPABASE_URL = process.env['SUPABASE_URL'];
        const SUPABASE_PUBLISHABLE_KEY = process.env['SUPABASE_PUBLISHABLE_KEY'];
        const OPENAI_API_KEY = process.env['OPENAI_API_KEY'];

        if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !OPENAI_API_KEY) {
          return new Response('Server configuration error', { status: 500 });
        }

        const authHeader = request.headers.get('authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return new Response('Unauthorized', { status: 401 });
        }
        const token = authHeader.replace('Bearer ', '');
        if (!token || token.split('.').length !== 3) {
          return new Response('Unauthorized', { status: 401 });
        }

        const body = await request.json().catch(() => null);
        if (!body || typeof body.text !== 'string' || !body.text.trim()) {
          return new Response('Bad request: text is required', { status: 400 });
        }
        const text = body.text.trim();

        const supabase = createClient<Database>(
          SUPABASE_URL,
          SUPABASE_PUBLISHABLE_KEY,
          {
            global: {
              fetch: createSupabaseFetch(SUPABASE_PUBLISHABLE_KEY),
              headers: {
                Authorization: `Bearer ${token}`,
              },
            },
            auth: {
              storage: undefined,
              persistSession: false,
              autoRefreshToken: false,
            },
          }
        );

        const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token);
        if (claimsError || !claimsData?.claims || !claimsData.claims.sub) {
          return new Response('Unauthorized', { status: 401 });
        }
        const userId = claimsData.claims.sub;

        const { data: roleRows, error: roleError } = await supabase
          .from('user_roles')
          .select('role')
          .eq('user_id', userId);

        if (roleError) {
          console.error('[synthesize-stream] role lookup error', roleError);
          return new Response('Server error', { status: 500 });
        }

        const roles = (roleRows ?? []).map(r => r.role);
        if (!roles.includes('arzt') && !roles.includes('patient')) {
          return new Response('Forbidden', { status: 403 });
        }

        const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'tts-1',
            voice: 'alloy',
            input: text,
            response_format: 'mp3',
          }),
        });

        if (!upstream.ok) {
          const errorText = await upstream.text().catch(() => '');
          console.error('[synthesize-stream] OpenAI error', upstream.status, errorText);
          return new Response('TTS failed', { status: 502 });
        }

        return new Response(upstream.body, {
          headers: {
            'Content-Type': 'audio/mpeg',
          },
        });
      },
    },
  },
})
