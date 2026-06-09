import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://dsrsctzumggkrmyuwodw.supabase.co'
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseServiceKey) {
  console.error("Please provide SUPABASE_SERVICE_ROLE_KEY environment variable")
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function setup() {
  const email = 'shashikant.zarekar@gemengserv.com'
  const password = 'Shashi@123'

  // Create or get user
  const { data: userResp, error: userError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  })

  let userId;
  if (userError) {
    if (userError.message.includes('already exists')) {
      const { data: existingUsers } = await supabase.auth.admin.listUsers()
      const existingUser = existingUsers.users.find(u => u.email === email)
      userId = existingUser?.id
      console.log('User already exists:', email)
    } else {
      console.error('Error creating user:', userError)
      return
    }
  } else {
    userId = userResp.user.id
    console.log('Created user:', email)
  }

  // Ensure tenant exists
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('id')
    .limit(1)
    .single()

  let tenantId;
  if (!tenant || tenantError) {
      const { data: newTenant, error: newTenantError } = await supabase
        .from('tenants')
        .insert({ name: 'Default Tenant' })
        .select()
        .single()
      tenantId = newTenant.id
      console.log('Created new tenant:', tenantId)
  } else {
      tenantId = tenant.id
      console.log('Using existing tenant:', tenantId)
  }

  // Ensure membership
  if (userId && tenantId) {
    const { data: existingMembership } = await supabase
        .from('memberships')
        .select('*')
        .eq('user_id', userId)
        .eq('tenant_id', tenantId)
        .single()

    if (!existingMembership) {
        await supabase.from('memberships').insert({
            user_id: userId,
            tenant_id: tenantId,
            role: 'admin'
        })
        console.log('Created membership for user in tenant')
    } else {
        console.log('Membership already exists')
    }
  }
}

setup()