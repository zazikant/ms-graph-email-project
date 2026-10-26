import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

// Click tracking redirector.
//
// Email links are rewritten at send time (see send-individual /
// process-batches) to:
//   <SUPABASE_URL>/functions/v1/track-click-v2?tid=<tracking_id>&url=<original>
// Every click 302-redirects to the original URL after logging a 'click'
// event. Kept in sync with track-open-v2.
//
// NOTE: this file was missing from the repo (only deployed via dashboard);
// reconstructed 2026-10-26 from agent/system/Edge_Functions.md docs and
// the link-rewriting code in send-individual/index.ts, and changed the
// counter update from a racy read-modify-write to the atomic
// increment_send_counter SQL function (see migration
// 20261026120000_increment_send_counter_rpc.sql).

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const tracking_id = url.searchParams.get('tid');
  const clicked_url = url.searchParams.get('url');

  if (tracking_id && clicked_url) {
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const supabase = createClient(supabaseUrl, supabaseKey);

      const { data: send } = await supabase
        .from('email_sends')
        .select('id')
        .eq('tracking_id', tracking_id)
        .single();

      if (send) {
        await supabase.from('email_events').insert({
          send_id: send.id,
          tracking_id,
          event_type: 'click',
          clicked_url,
        });
        // Atomic increment -- same race fix as track-open-v2 (a
        // read-modify-write here lost clicks whenever a mail scanner
        // fired several link checks within milliseconds).
        await supabase.rpc('increment_send_counter', {
          p_send_id: send.id,
          p_event_type: 'click',
        });
      }
    } catch (e) {
      console.error('Click tracking error:', e);
    }
  }

  // no-store so proxies/browsers re-hit the function on every click;
  // a cached 302 would undercount repeat clicks.
  const headers = {
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
  };

  if (clicked_url) {
    return new Response(null, { status: 302, headers: { ...headers, Location: clicked_url } });
  }
  return new Response('Bad request: missing tid or url', { status: 400, headers });
});
