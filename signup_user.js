import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://dsrsctzumggkrmyuwodw.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRzcnNjdHp1bWdna3JteXV3b2R3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxNTA4NDYsImV4cCI6MjA5MTcyNjg0Nn0.xPhEL5cM3JjtSCnxn4NvaDZC5ZTRezi0TPOfZQ3d_7A'

const supabase = createClient(supabaseUrl, supabaseAnonKey)

async function setup() {
  const email = 'shashikant.zarekar@gemengserv.com'
  const password = 'Shashi@123'

  console.log('Attempting to sign up user...')
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  })

  if (error) {
    if (error.message.includes('already registered')) {
        console.log('User already exists!')
    } else {
        console.error('Sign up error:', error.message)
    }
  } else {
    console.log('User created successfully:', data.user?.id)
  }
}

setup()