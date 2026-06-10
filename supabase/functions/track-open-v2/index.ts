import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  // Critical: no-cache headers so email clients re-fetch on every open.
  // Without these, the tracking pixel is cached for a year and only the first
  // open is recorded. (Gmail uses its own image proxy so it works either way;
  // Microsoft 365 / Outlook respect these cache headers, so this is the
  // difference between "1 open" and "multiple opens".)
  'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
  'Pragma': 'no-cache',
  'Expires': '0'
};

const trackingPixel = `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==`;

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const tracking_id = url.searchParams.get('tid');

  if (tracking_id) {
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const supabase = createClient(supabaseUrl, supabaseKey);

      const { data: send } = await supabase
        .from('email_sends')
        .select('id, open_count')
        .eq('tracking_id', tracking_id)
        .single();

      if (send) {
        await supabase.from('email_events').insert({
          send_id: send.id,
          tracking_id,
          event_type: 'open',
        });
        await supabase
          .from('email_sends')
          .update({ open_count: (send.open_count || 0) + 1 })
          .eq('id', send.id);
      }
    } catch (e) {
      console.error('Open tracking error:', e);
    }
  }

  const bytes = Uint8Array.from(atob(trackingPixel), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: { ...corsHeaders, 'Content-Type': 'image/png' },
  });
});
