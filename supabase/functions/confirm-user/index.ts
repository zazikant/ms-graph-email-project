import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"

Deno.serve(async (req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const authHeader = req.headers.get("Authorization")
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401, headers: { "Content-Type": "application/json" }
      })
    }

    const { email } = await req.json()

    if (!email) {
      return new Response(JSON.stringify({ error: "Email is required" }), {
        status: 400, headers: { "Content-Type": "application/json" }
      })
    }

    const { data, error } = await supabase.auth.admin.updateUserByEmail(
      email,
      { email_confirm: true }
    )

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { "Content-Type": "application/json" }
      })
    }

    return new Response(JSON.stringify({ success: true, user: data.user }), {
      status: 200, headers: { "Content-Type": "application/json" }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    })
  }
})
