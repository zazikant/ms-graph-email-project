import { useState, useEffect } from 'react'
import { supabase, supabaseUrl, supabaseAnonKey } from './supabase'
import type { Session } from '@supabase/supabase-js'

const MANAGE_TOKEN_URL = `${supabaseUrl}/functions/v1/manage-token`
const MS_AUTH_URL = `${supabaseUrl}/functions/v1/ms-auth`
const AZURE_CONFIG_URL = `${supabaseUrl}/functions/v1/manage-azure-config`
const SEND_INDIVIDUAL_URL = `${supabaseUrl}/functions/v1/send-individual`
const SCHEDULE_BATCH_URL = `${supabaseUrl}/functions/v1/schedule-batch`
const CONFIRM_USER_URL = `${supabaseUrl}/functions/v1/confirm-user`

type AuthView = 'login' | 'signup' | 'pending' | 'invitation_required'

// ===== Bulk-operation helpers =====
// Supabase PostgREST caps every SELECT at 1000 rows by default.
// Any list that needs to load "everything" -- contacts, email_sends,
// recipient_list, etc. -- must therefore be paginated through .range()
// to bypass the cap. The helpers below also chunk .in() filters because
// PostgREST encodes .in() values in the URL, and URLs longer than ~8KB
// return 414 URI Too Long. Practical limit is ~300 UUIDs per request.

/** Split an array into chunks of `size`. */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// PostgREST .in() URL-length safety limit. UUIDs are 36 chars + comma,
// so 200 UUIDs ~= 7.4KB -- safely under the 8KB PostgREST/Supabase gateway limit.
const POSTGREST_IN_CHUNK = 200

/**
 * Extract a human-readable message from anything thrown by the Supabase
 * client. Supabase query errors are PLAIN OBJECTS (PostgrestError), not
 * Error instances, so `String(err)` renders "[object Object]" and hides
 * the real cause (e.g. "canceling statement due to statement timeout").
 * This helper always surfaces the actual `message` field when present.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message
    if (typeof msg === 'string' && msg) return msg
  }
  return String(err)
}

// ---- CSV hardening helpers (shared by History + Contacts exports) ----
// Excel quirks that previously shredded exported sheets:
//  1. CR/LF/tab inside a cell act as row/column breaks even inside quoted
//     fields -> control characters are stripped from every value.
//  2. Every cell is hard-capped at 32,767 chars; a LONGER quoted field
//     makes Excel's CSV parser lose field boundaries and merge/shred the
//     following records (27 over-limit "All Events" fields produced the
//     garbage rows reported on 15-10). Values are capped well below it.
//  3. Generated timestamps must never contain commas: formatIST()'s en-IN
//     locale emits "15-10-2026, 13:00:39", and commas inside values break
//     paste / Text-to-Columns imports that ignore quote characters.
const sanitizeCsvValue = (val: unknown): string =>
  String(val ?? '')
    // eslint-disable-next-line no-control-regex -- intentional: strip C0 control chars Excel treats as breaks
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()

// Comfortably below Excel's 32,767-char per-cell limit.
const EXCEL_CELL_SAFE_MAX = 29900

const capCsvValue = (val: string): string =>
  val.length <= EXCEL_CELL_SAFE_MAX ? val : val.slice(0, EXCEL_CELL_SAFE_MAX) + '...'

const csvCell = (val: unknown): string => {
  const v = capCsvValue(sanitizeCsvValue(val))
  return `"${v.replace(/"/g, '""')}"`
}

// Legacy alias kept for existing callers (contacts export).
const csvEscape = (val: string): string => csvCell(val)

// IST timestamp for CSV cells: "15-10-2026 13:00:39" (space separator, no
// comma — see note 3 above). Same time zone and values as formatIST().
const csvIST = (dateStr: string | null | undefined): string => {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return ''
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(d)
  const get = (t: string) => p.find(x => x.type === t)?.value ?? ''
  return `${get('day')}-${get('month')}-${get('year')} ${get('hour')}:${get('minute')}:${get('second')}`
}

// "All Events" cell: one `type:time:url` segment per event, capped below
// the Excel cell limit at an EVENT boundary (never mid-timestamp) with an
// explicit "(+N more)" note, so heavy-clicker records can no longer push
// Excel's CSV parser past its 32,767-char limit and shred the sheet.
const buildAllEventsCell = (evtList: EmailEvent[]): string => {
  const SUFFIX_RESERVE = 60
  const kept: string[] = []
  let len = 0
  for (const e of evtList) {
    const part = capCsvValue(
      `${e.event_type}:${csvIST(e.created_at)}${e.clicked_url ? ':' + sanitizeCsvValue(e.clicked_url) : ''}`
    )
    const add = (kept.length === 0 ? 0 : 2) + part.length
    if (len + add > EXCEL_CELL_SAFE_MAX - SUFFIX_RESERVE) break
    kept.push(part)
    len += add
  }
  if (kept.length === evtList.length) return kept.join('; ')
  return `${kept.join('; ')}; ...(+${evtList.length - kept.length} more events not shown)`
}

/**
 * Exhaust a Supabase SELECT builder through .range() pagination so the
 * 1000-row PostgREST cap does not silently truncate the result.
 *
 * Usage:
 *   const all = await fetchAllPaginated(
 *     supabase.from('contacts').select('*').eq('tenant_id', tenantId)
 *   )
 */
async function fetchAllPaginated<T = any>(
  // Typed loosely on purpose: supabase-js returns PostgrestFilterBuilder
  // which is a Thenable (not a real Promise), so a stricter signature
  // would force every call site to cast. We only call .range() on it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  builder: any,
  pageSize = 1000
): Promise<T[]> {
  const all: T[] = []
  let from = 0
  // Hard upper bound to prevent an accidental infinite loop.
  const MAX_ROWS = 1_000_000
  while (from < MAX_ROWS) {
    const to = from + pageSize - 1
    const { data, error } = await builder.range(from, to)
    if (error) throw error
    if (!data || data.length === 0) break
    all.push(...(data as T[]))
    if (data.length < pageSize) break // last page reached
    from += pageSize
  }
  return all
}

/**
 * Fetch ALL rows from `email_events` / `send_attachments` for a set of
 * send IDs. Two PostgREST limits apply and BOTH must be handled:
 *   1. .in() URL-length cap      -> chunk the send IDs (POSTGREST_IN_CHUNK)
 *   2. 1000-row per-request cap  -> paginate each chunk via fetchAllPaginated
 * A single visible History page can hold sends with >1000 combined events
 * (e.g. one send with 992 clicks + 1200 opens), so the page-view fetch
 * needs the same chunk+range treatment as the CSV export.
 */
async function fetchAllForSends<T>(
  table: 'email_events' | 'send_attachments',
  sendIds: string[]
): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < sendIds.length; i += POSTGREST_IN_CHUNK) {
    const chunk = sendIds.slice(i, i + POSTGREST_IN_CHUNK)
    const base = supabase.from(table).select('*').in('send_id', chunk)
    const q = table === 'email_events'
      ? base.order('created_at', { ascending: true })
      : base
    out.push(...(await fetchAllPaginated<T>(q)))
  }
  return out
}

/**
 * List every object in a Supabase Storage folder by paginating
 * `.list(folder, { limit, offset })`. The storage API caps `limit` at
 * 100 per request and silently truncates beyond that, so we loop on offset.
 */
async function listAllStorageFiles(
  bucket: string,
  folder: string,
  pageSize = 100
): Promise<{ name: string; id: string; updated_at?: string; metadata?: Record<string, unknown> }[]> {
  const out: { name: string; id: string; updated_at?: string; metadata?: Record<string, unknown> }[] = []
  let offset = 0
  const MAX_FILES = 100_000
  while (offset < MAX_FILES) {
    const { data, error } = await supabase
      .storage
      .from(bucket)
      .list(folder, { limit: pageSize, offset, sortBy: { column: 'name', order: 'asc' } })
    if (error) throw error
    if (!data || data.length === 0) break
    out.push(...data.map(f => ({
      name: f.name,
      id: f.id ?? '',
      updated_at: f.updated_at || '',
      metadata: f.metadata || {}
    })))
    if (data.length < pageSize) break
    offset += pageSize
  }
  return out
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [authView, setAuthView] = useState<AuthView>('login')
  const [pendingEmail, setPendingEmail] = useState('')

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        checkMembershipStatus(session)
      } else {
        setSession(null)
        setLoading(false)
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        checkMembershipStatus(session)
      } else {
        setSession(null)
        setLoading(false)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  const checkMembershipStatus = async (sess: Session) => {
    try {
      const { data: membership } = await supabase
        .from('memberships')
        .select('tenant_id, role')
        .eq('user_id', sess.user.id)
        .single()

      if (membership) {
        setSession(sess)
        setLoading(false)
      } else {
        // Check if there's a pending invitation for this user's email
        const { data: invitation } = await supabase
          .from('invitations')
          .select('*')
          .eq('email', sess.user.email)
          .eq('status', 'pending')
          .single()

        if (invitation) {
          // Auto-approve: create membership
          await supabase.from('memberships').insert({
            tenant_id: invitation.tenant_id,
            user_id: sess.user.id,
            role: invitation.role
          })

          // Update invitation status
          await supabase
            .from('invitations')
            .update({ status: 'approved' })
            .eq('id', invitation.id)

          setSession(sess)
          setLoading(false)
        } else {
          setSession(null)
          setLoading(false)
        }
      }
    } catch {
      setSession(null)
      setLoading(false)
    }
  }

  const handleLogin = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  }

  const handleSignup = async (email: string, password: string, fullName: string) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName }
      }
    })
    if (error) throw error

    if (data.user) {
      // Check if there's a pending invitation for this email
      const { data: invitation } = await supabase
        .from('invitations')
        .select('*')
        .eq('email', email.toLowerCase())
        .eq('status', 'pending')
        .single()

      if (invitation) {
        // Auto-approve: create membership immediately
        await supabase.from('memberships').insert({
          tenant_id: invitation.tenant_id,
          user_id: data.user.id,
          role: invitation.role
        })

        await supabase
          .from('invitations')
          .update({ status: 'approved' })
          .eq('id', invitation.id)

        // Refresh session to get new membership
        const { data: sessData } = await supabase.auth.getSession()
        if (sessData?.session) {
          setSession(sessData.session)
        }
      } else {
        // No invitation found — create a pending invitation record so admins can approve
        // This allows signup-first flow: user signs up → admin sees pending invite → approves
        const { error: inviteError } = await supabase
          .from('invitations')
          .insert({
            tenant_id: null, // null = universal pending, any admin can approve
            email: email.toLowerCase(),
            role: 'member',
            invited_by: null, // signup-first flow, no inviter
            status: 'pending'
          })

        if (inviteError) {
          console.error('Failed to create pending invitation:', inviteError)
        }

        setPendingEmail(email)
        setAuthView('pending')
      }
    }
  }

  const handleSignOut = () => {
    setSession(null)
    setAuthView('login')
    setPendingEmail('')
    supabase.auth.signOut()
  }

  if (loading) return <div className="p-8">Loading...</div>

  if (!session) {
    if (authView === 'pending') {
      return <PendingApprovalView email={pendingEmail} onBackToLogin={() => setAuthView('login')} />
    }
    return (
      <div className="min-h-screen bg-gray-100 py-12 px-4 flex justify-center items-center">
        <div className="bg-white p-8 rounded shadow-md w-96 space-y-4">
          {authView === 'login' ? (
            <>
              <LoginForm onLogin={handleLogin} />
              <div className="text-center">
                <span className="text-gray-500">Don't have an account? </span>
                <button onClick={() => setAuthView('signup')} className="text-blue-600 hover:underline">
                  Sign Up
                </button>
              </div>
            </>
          ) : (
            <>
              <SignupForm onSignup={handleSignup} />
              <div className="text-center">
                <span className="text-gray-500">Already have an account? </span>
                <button onClick={() => setAuthView('login')} className="text-blue-600 hover:underline">
                  Sign In
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    )
  }

  return <Dashboard session={session} onSignOut={handleSignOut} />
}

function PendingApprovalView({ email, onBackToLogin }: { email: string; onBackToLogin: () => void }) {
  return (
    <div className="min-h-screen bg-gray-100 py-12 px-4 flex justify-center items-center">
      <div className="bg-white p-8 rounded shadow-md w-96 space-y-4 text-center">
        <div className="text-4xl">⏳</div>
        <h2 className="text-2xl font-bold text-yellow-600">Pending Approval</h2>
        <p className="text-gray-600">
          Your account has been created, but <strong>{email}</strong> is pending approval from an administrator.
        </p>
        <p className="text-sm text-gray-500">
          You'll receive an email once your account is approved.
        </p>
        <button onClick={onBackToLogin} className="w-full bg-blue-600 text-white py-2 rounded mt-4">
          Back to Login
        </button>
      </div>
    </div>
  )
}

function LoginForm({ onLogin }: { onLogin: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      await onLogin(email, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    }
    setLoading(false)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <h2 className="text-2xl font-bold text-center">Email Marketing Login</h2>
      <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} className="w-full border p-2 rounded" required />
      <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} className="w-full border p-2 rounded" required />
      <button type="submit" disabled={loading} className="w-full bg-blue-600 text-white py-2 rounded">
        {loading ? 'Signing in...' : 'Sign In'}
      </button>
      {error && <p className="text-red-600 text-sm">{error}</p>}
    </form>
  )
}

function SignupForm({ onSignup }: { onSignup: (email: string, password: string, name: string) => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      await onSignup(email, password, fullName)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign up failed')
    }
    setLoading(false)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <h2 className="text-2xl font-bold text-center">Create Account</h2>
      <input type="text" placeholder="Full Name" value={fullName} onChange={e => setFullName(e.target.value)} className="w-full border p-2 rounded" required />
      <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} className="w-full border p-2 rounded" required />
      <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} className="w-full border p-2 rounded" required />
      <button type="submit" disabled={loading} className="w-full bg-green-600 text-white py-2 rounded">
        {loading ? 'Creating...' : 'Sign Up'}
      </button>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <p className="text-xs text-gray-500 text-center">
        After sign up, an administrator will need to approve your account before you can use it.
      </p>
    </form>
  )
}

function Dashboard({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const [activeTab, setActiveTab] = useState<'compose' | 'contacts' | 'history' | 'files' | 'lists' | 'settings' | 'invitations' | 'batches'>('compose')
  const [pendingAttachments, setPendingAttachments] = useState<{name: string, path: string, size: number}[]>([])
  const [filterListId, setFilterListId] = useState<string | null>(null)
  const [refreshListsKey, setRefreshListsKey] = useState(0)
  const [userRole, setUserRole] = useState<string | null>(null)

  useEffect(() => {
    const fetchRole = async () => {
      const { data } = await supabase
        .from('memberships')
        .select('role')
        .eq('user_id', session.user.id)
        .single()
      if (data) setUserRole(data.role)
    }
    fetchRole()
  }, [session.user.id])

  const handleSelectList = (listId: string | null) => {
    setFilterListId(listId)
    setActiveTab('contacts')
  }

  const handleListsChanged = () => {
    setRefreshListsKey(k => k + 1)
  }

  const handleTabChange = (tab: string) => {
    if (tab === 'contacts') {
      setFilterListId(null)
    }
    setActiveTab(tab as typeof activeTab)
  }

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
          <h1 className="text-xl font-bold">Email Marketing</h1>
          <div className="flex items-center gap-4">
            {userRole === 'admin' && (
              <button
                onClick={() => handleTabChange('invitations')}
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                Invitations
              </button>
            )}
            <button onClick={onSignOut} className="text-sm text-gray-600 hover:text-black">Sign Out</button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto px-4 py-8 w-full">
        <div className="mb-6 flex space-x-4 border-b">
          <button
            className={`pb-2 px-1 ${activeTab === 'compose' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}
            onClick={() => handleTabChange('compose')}
          >
            Compose
          </button>
          <button
            className={`pb-2 px-1 ${activeTab === 'contacts' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}
            onClick={() => handleTabChange('contacts')}
          >
            Contacts
          </button>
          <button
            className={`pb-2 px-1 ${activeTab === 'history' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}
            onClick={() => handleTabChange('history')}
          >
            History
          </button>
          <button
            className={`pb-2 px-1 ${activeTab === 'files' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}
            onClick={() => handleTabChange('files')}
          >
            Files
          </button>
          <button
            className={`pb-2 px-1 ${activeTab === 'lists' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}
            onClick={() => handleTabChange('lists')}
          >
            Lists
          </button>
          <button
            className={`pb-2 px-1 ${activeTab === 'batches' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}
            onClick={() => handleTabChange('batches')}
          >
            Batches
          </button>
          <button
            className={`pb-2 px-1 ${activeTab === 'settings' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}
            onClick={() => handleTabChange('settings')}
          >
            Settings
          </button>
        </div>

        {activeTab === 'compose' && <ComposeTab session={session} attachments={pendingAttachments} setAttachments={setPendingAttachments} />}
        {activeTab === 'contacts' && <ContactsTab session={session} filterListId={filterListId} refreshListsKey={refreshListsKey} />}
        {activeTab === 'history' && <HistoryTab session={session} />}
        {activeTab === 'files' && <FilesTab session={session} />}
        {activeTab === 'lists' && <ListsTab session={session} onSelectList={handleSelectList} onListsChanged={handleListsChanged} />}
        {activeTab === 'batches' && <BatchesTab session={session} />}
        {activeTab === 'settings' && <SettingsTab session={session} />}
        {activeTab === 'invitations' && <InvitationsTab session={session} />}
      </main>
    </div>
  )
}

function ComposeTab({ session, attachments, setAttachments }: { session: Session, attachments: {name: string, path: string, size: number}[], setAttachments: (a: {name: string, path: string, size: number}[]) => void }) {
  const [recipient, setRecipient] = useState('')
  const [subject, setSubject] = useState('')
  const [htmlContent, setHtmlContent] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)
  const [sendLater, setSendLater] = useState(false)
  const [scheduledAt, setScheduledAt] = useState('')
  const [availableFiles, setAvailableFiles] = useState<{name: string, path: string, size: number}[]>([])
  const [selectedFiles, setSelectedFiles] = useState<{name: string, path: string, size: number}[]>(attachments)
  const [showFilePicker, setShowFilePicker] = useState(false)
  const [pastedUrl, setPastedUrl] = useState('')
  const [uploadingFile, setUploadingFile] = useState(false)
  const [fileToUpload, setFileToUpload] = useState<File | null>(null)
  const [contacts, setContacts] = useState<{email: string, name: string | null}[]>([])
  const [showContactDropdown, setShowContactDropdown] = useState(false)
  const [lists, setLists] = useState<{id: string, name: string}[]>([])
  const [selectedListId, setSelectedListId] = useState('')
  const [recipientMode, setRecipientMode] = useState<'single' | 'list'>('single')

  const BUCKET_NAME = 'dfsdfsdf'
  const [tenantId, setTenantId] = useState<string | null>(null)

  useEffect(() => {
    if (!session?.user?.id) return
    const fetchTenantAndFiles = async () => {
      const { data: membership } = await supabase.from('memberships').select('tenant_id').eq('user_id', session.user.id).single()
      if (!membership) return
      setTenantId(membership.tenant_id)
      // Paginated storage list -- bypasses the 100-object cap on .list()
      try {
        const allFiles = await listAllStorageFiles(BUCKET_NAME, membership.tenant_id)
        setAvailableFiles(allFiles.map(f => ({
          name: f.name,
          path: `${membership.tenant_id}/${f.name}`,
          size: (f.metadata?.size as number) || 0
        })))
      } catch (err) {
        console.error('Failed to list storage files:', err)
      }
    }
    fetchTenantAndFiles()
  }, [session?.user?.id])

  useEffect(() => {
    const fetchContacts = async () => {
      const { data: membership } = await supabase.from('memberships').select('tenant_id').eq('user_id', session.user.id).single()
      if (!membership) return
      // Paginated -- bypasses the 1000-row PostgREST cap. Important because
      // the autocomplete dropdown is sourced from this list, and tenants
      // with >1000 subscribers would otherwise see only the first page.
      try {
        const all = await fetchAllPaginated<{ email: string; name: string | null }>(
          supabase.from('contacts').select('email, name').eq('tenant_id', membership.tenant_id).neq('status', 'hardbounced')
        )
        setContacts(all)
      } catch (err) {
        console.error('Failed to load contacts:', err)
      }

      // Paginated -- the bare .select() caps at 1000 rows, so a tenant with
      // >1000 lists would silently lose the tail of the recipient picker.
      try {
        const listsData = await fetchAllPaginated<{ id: string; name: string }>(
          supabase.from('lists').select('id, name').eq('tenant_id', membership.tenant_id).order('name')
        )
        setLists(listsData)
      } catch (err) {
        console.error('Failed to load lists:', err)
      }
    }
    fetchContacts()

    const interval = setInterval(fetchContacts, 10000)
    return () => clearInterval(interval)
  }, [session.user.id])

  const filteredContacts = recipient.trim() 
    ? contacts.filter(c => 
        c.email.toLowerCase().includes(recipient.toLowerCase()) || 
        (c.name && c.name.toLowerCase().includes(recipient.toLowerCase()))
      ).slice(0, 5)
    : []

  const selectContact = (email: string) => {
    setRecipient(email)
    setShowContactDropdown(false)
  }

  const refreshFiles = async () => {
    if (!tenantId) return
    try {
      const allFiles = await listAllStorageFiles(BUCKET_NAME, tenantId)
      setAvailableFiles(allFiles.map(f => ({
        name: f.name,
        path: `${tenantId}/${f.name}`,
        size: (f.metadata?.size as number) || 0
      })))
    } catch (err) {
      console.error('Failed to refresh files:', err)
    }
  }

  const addFile = (file: {name: string, path: string, size: number}) => {
    if (!selectedFiles.find(f => f.path === file.path)) {
      const newFiles = [...selectedFiles, file]
      setSelectedFiles(newFiles)
      setAttachments(newFiles)
    }
  }

  const removeFile = (path: string) => {
    const newFiles = selectedFiles.filter(f => f.path !== path)
    setSelectedFiles(newFiles)
    setAttachments(newFiles)
  }

  const toggleFile = (file: {name: string, path: string, size: number}) => {
    if (selectedFiles.find(f => f.path === file.path)) {
      removeFile(file.path)
    } else {
      addFile(file)
    }
  }

  const handleAddFromUrl = () => {
    if (!pastedUrl.trim()) return
    const url = pastedUrl.trim()
    const fileName = url.split('/').pop() || 'file'
    const pathMatch = url.match(/storage\/v1\/object\/public\/[^/]+\/(.+)$/)
    if (pathMatch) {
      addFile({ name: fileName, path: pathMatch[1], size: 0 })
      setPastedUrl('')
    } else {
      alert('Invalid URL. Please paste a valid Supabase storage URL.')
    }
  }

  const extractFileName = (url: string) => {
    const match = url.match(/storage\/v1\/object\/public\/[^/]+\/(.+)$/)
    if (match) return match[1].split('/').pop() || 'file'
    return url.split('/').pop() || 'file'
  }

  const handleUrlChange = (value: string) => {
    setPastedUrl(value)
  }

  const handleFileUpload = async () => {
    if (!fileToUpload || !tenantId) return
    setUploadingFile(true)
    try {
      const ext = fileToUpload.name.split('.').pop()
      const baseName = fileToUpload.name.replace(`.${ext}`, '')
      const timestamp = Date.now()
      const uniquePath = `${tenantId}/${timestamp}-${baseName}.${ext}`
      
      const { error } = await supabase.storage.from(BUCKET_NAME).upload(uniquePath, fileToUpload, {
        cacheControl: '3600',
        upsert: false
      })
      
      if (error) throw error
      
      addFile({ name: fileToUpload.name, path: uniquePath, size: fileToUpload.size })
      refreshFiles()
      setFileToUpload(null)
    } catch (err) {
      alert(`Upload failed: ${errorMessage(err)}`)
    }
    setUploadingFile(false)
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setStatus('Sending...')

    try {
      const { data: membership } = await supabase
        .from('memberships')
        .select('tenant_id')
        .eq('user_id', session.user.id)
        .single()

      if (!membership) throw new Error('No tenant found')

      if (recipientMode === 'list' && selectedListId) {
        const batchBody: Record<string, unknown> = {
          list_id: selectedListId,
          subject,
          content: htmlContent,
          attachments: selectedFiles
        }
        if (sendLater && scheduledAt) {
          batchBody.scheduled_at = new Date(scheduledAt).toISOString()
        }
        const response = await fetch(SCHEDULE_BATCH_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
            'apikey': supabaseAnonKey
          },
          body: JSON.stringify(batchBody)
        })

        const data = await response.json()

        if (response.status === 403 && data.code === 'token_expired') {
          throw new Error('Your Microsoft Graph token has expired. Please update it in Settings.')
        }

        if (!response.ok) throw new Error(data.error || 'Failed to schedule batch')

        setStatus(data.message || `Batch scheduled! ${data.total_count} contacts queued. Processing will begin shortly.`)
      } else {
        const body: Record<string, unknown> = {
          recipient,
          subject,
          content: htmlContent,
          attachments: selectedFiles,
          correlation_id: crypto.randomUUID()
        }
        if (sendLater && scheduledAt) {
          body.scheduled_at = new Date(scheduledAt).toISOString()
        }
        const response = await fetch(SEND_INDIVIDUAL_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
            'apikey': supabaseAnonKey
          },
          body: JSON.stringify(body)
        })

        const data = await response.json()

        if (response.status === 403 && data.code === 'token_expired') {
          throw new Error('Your Microsoft Graph token has expired. Please update your access token in Settings.')
        }

        if (response.status === 429) {
          const retrySec = data.retry_after_seconds || 3600
          throw new Error(`Rate limited by Microsoft. Please try again in ${Math.ceil(retrySec / 60)} minutes.`)
        }

        if (!response.ok) throw new Error(data.error || data.code || 'Failed to send')

        if (data.scheduled) {
          setStatus(`Email scheduled for ${data.scheduled_at}. It will be sent automatically.`)
        } else {
          setStatus('Email sent successfully!')
        }
      }

      setRecipient('')
      setSubject('')
      setHtmlContent('')
      setSelectedFiles([])
      setSelectedListId('')
      setSendLater(false)
      setScheduledAt('')
    } catch (err) {
      setStatus(`Error: ${errorMessage(err)}`)
    }

    setLoading(false)
  }

  return (
    <div className="bg-white p-6 rounded shadow">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="flex gap-4 mb-4">
          <label className="flex items-center gap-2">
            <input type="radio" checked={recipientMode === 'single'} onChange={() => setRecipientMode('single')} />
            Single Recipient
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={recipientMode === 'list'} onChange={() => setRecipientMode('list')} />
            Send to List
          </label>
        </div>

        {recipientMode === 'single' ? (
          <div>
            <label className="block text-sm font-medium mb-1">Recipient Email</label>
            <div className="relative">
              <input 
                type="email" 
                value={recipient} 
                onChange={e => { setRecipient(e.target.value); setShowContactDropdown(e.target.value.length > 0); }} 
                onBlur={() => setTimeout(() => setShowContactDropdown(false), 150)}
                className="w-full border p-2 rounded" 
                required={recipientMode === 'single'}
              />
              {showContactDropdown && filteredContacts.length > 0 && (
                <div className="absolute z-10 w-full bg-white border rounded shadow-lg mt-1 max-h-48 overflow-auto">
                  {filteredContacts.map((c, i) => (
                    <div 
                      key={i} 
                      onClick={() => selectContact(c.email)}
                      className="p-2 hover:bg-gray-100 cursor-pointer border-b last:border-b-0"
                    >
                      <div className="font-medium">{c.email}</div>
                      {c.name && <div className="text-xs text-gray-500">{c.name}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div>
            <label className="block text-sm font-medium mb-1">Select List</label>
            <select 
              value={selectedListId} 
              onChange={e => setSelectedListId(e.target.value)}
              className="w-full border p-2 rounded"
              required={recipientMode === 'list'}
            >
              <option value="">Choose a list...</option>
              {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="block text-sm font-medium mb-1">Subject</label>
          <input type="text" value={subject} onChange={e => setSubject(e.target.value)} className="w-full border p-2 rounded" required />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">HTML Content</label>
          <textarea value={htmlContent} onChange={e => setHtmlContent(e.target.value)} rows={8} className="w-full border p-2 rounded font-mono text-sm" required />
          <div className="flex items-center gap-2 mt-1">
            <p className="text-xs text-gray-500">Supports HTML. Links will be automatically tracked.</p>
            <button
              type="button"
              onClick={() => setHtmlContent(prev => prev + '{name}')}
              className="text-xs text-blue-600 hover:underline"
              title="Insert contact name placeholder"
            >
              + Insert {'{name}'}
            </button>
            <span className="text-xs text-gray-400">| Available: {'{name}'}</span>
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium">Attachments</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowFilePicker(!showFilePicker)}
                className="text-blue-600 hover:underline text-sm"
              >
                {showFilePicker ? 'Hide Files' : 'Select from Bucket'}
              </button>
            </div>
          </div>
          
          {/* URL Paste Input */}
          <div className="mb-2">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Paste Supabase storage URL to add..."
                value={pastedUrl}
                onChange={e => handleUrlChange(e.target.value)}
                className="flex-1 border p-2 rounded text-sm"
              />
              <button
                type="button"
                onClick={handleAddFromUrl}
                disabled={!pastedUrl.trim()}
                className="bg-gray-600 text-white px-3 py-2 rounded text-sm disabled:opacity-50"
              >
                Add
              </button>
            </div>
            {pastedUrl.includes('storage/v1/object') && (
              <div className="mt-1 text-xs text-green-600">
                📎 Will add: {extractFileName(pastedUrl)}
              </div>
            )}
          </div>
          
          {/* Manual Upload */}
          <div className="flex gap-2 mb-2">
            <input
              type="file"
              onChange={e => e.target.files?.[0] && setFileToUpload(e.target.files[0])}
              className="text-sm"
            />
            <button
              type="button"
              onClick={handleFileUpload}
              disabled={!fileToUpload || uploadingFile}
              className="bg-green-600 text-white px-3 py-2 rounded text-sm disabled:opacity-50"
            >
              {uploadingFile ? 'Uploading...' : 'Upload New'}
            </button>
            {fileToUpload && <span className="text-sm text-gray-500 self-center">{fileToUpload.name}</span>}
          </div>
          
          {selectedFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {selectedFiles.map(path => {
                const file = availableFiles.find(f => f.path === path.path) || path
                return (
                  <span key={path.path} className="bg-blue-100 text-blue-800 px-2 py-1 rounded text-xs flex items-center gap-1">
                    📎 {file.name}
                    <button type="button" onClick={() => removeFile(path.path)} className="ml-1 text-blue-600 hover:text-blue-800">×</button>
                  </span>
                )
              })}
            </div>
          )}
          
          {showFilePicker && availableFiles.length > 0 && (
            <div className="border rounded max-h-40 overflow-y-auto p-2 space-y-1">
              {availableFiles.map(file => (
                <label key={file.path} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 p-1 rounded">
                  <input
                    type="checkbox"
                    checked={selectedFiles.some(f => f.path === file.path)}
                    onChange={() => toggleFile(file)}
                    className="rounded"
                  />
                  <span className="text-sm truncate flex-1" title={file.name}>{file.name}</span>
                  <span className="text-xs text-gray-400">{formatSize(file.size)}</span>
                </label>
              ))}
            </div>
          )}
          
          {showFilePicker && availableFiles.length === 0 && (
            <p className="text-gray-400 text-sm">No files in storage. Upload files in Files tab first.</p>
          )}
        </div>

        <div className="border-t pt-4 mt-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={sendLater}
              onChange={(e) => {
                setSendLater(e.target.checked)
                if (!e.target.checked) setScheduledAt('')
              }}
              className="rounded"
            />
            <span className="text-sm font-medium">Send Later</span>
          </label>
          {sendLater && (
            <div className="mt-2 ml-7">
              <label className="block text-sm font-medium mb-1">Scheduled Date & Time</label>
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                min={new Date().toISOString().slice(0, 16)}
                className="border p-2 rounded w-full"
                required={sendLater}
              />
              <p className="text-xs text-gray-500 mt-1">
                Email will be sent automatically at the scheduled time.
              </p>
            </div>
          )}
        </div>

        <button type="submit" disabled={loading} className="w-full bg-blue-600 text-white py-2 rounded">
          {loading ? 'Sending...' : sendLater ? 'Schedule Email' : 'Send Email'}
        </button>
      </form>
      {status && (
        <div className={`mt-4 p-2 rounded text-sm ${status.includes('Error') ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-800'}`}>
          {status}
        </div>
      )}
    </div>
  )
}

interface Contact {
  id: string
  email: string
  name: string | null
  status: string
  list_id: string | null
  created_at: string
}

interface ContactList {
  id: string
  name: string
  created_at: string
}

function ContactsTab({ session, filterListId, refreshListsKey = 0 }: { session: Session, filterListId: string | null, refreshListsKey?: number }) {
  // Server-side pagination state — same pattern as HistoryTab.
  // Only the visible page of CONTACTS_PER_PAGE rows is held in memory
  // at a time. The previous implementation loaded 500 contacts at once,
  // which for tenants with 3000+ contacts was the slowest-loading tab
  // in the app.
  const CONTACTS_PER_PAGE = 10

  const [contacts, setContacts] = useState<Contact[]>([])
  const [lists, setLists] = useState<ContactList[]>([])
  const [loading, setLoading] = useState(true)
  const [newEmail, setNewEmail] = useState('')
  const [newName, setNewName] = useState('')
  const [newStatus, setNewStatus] = useState('subscribed')
  const [newListId, setNewListId] = useState('')
  const [searchEmail, setSearchEmail] = useState('')
  const [searchName, setSearchName] = useState('')
  const [exactMatch, setExactMatch] = useState(false)
  const [filterStatus, setFilterStatus] = useState('')
  const [filterList, setFilterList] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [uploading, setUploading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [totalCount, setTotalCount] = useState(0)
  const [tenantId, setTenantId] = useState<string | null>(null)

  // Debounce search inputs so we don't fire a Supabase query on every
  // keystroke. Same default as HistoryTab (350ms).
  const [debouncedSearchEmail, setDebouncedSearchEmail] = useState('')
  const [debouncedSearchName, setDebouncedSearchName] = useState('')
  const [debouncedFilterStatus, setDebouncedFilterStatus] = useState('')
  const [debouncedFilterList, setDebouncedFilterList] = useState('')
  const [debouncedDateFrom, setDebouncedDateFrom] = useState('')
  const [debouncedDateTo, setDebouncedDateTo] = useState('')
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearchEmail(searchEmail)
      setDebouncedSearchName(searchName)
      setDebouncedFilterStatus(filterStatus)
      setDebouncedFilterList(filterList)
      setDebouncedDateFrom(dateFrom)
      setDebouncedDateTo(dateTo)
    }, 350)
    return () => clearTimeout(t)
  }, [searchEmail, searchName, filterStatus, filterList, dateFrom, dateTo])

  const hasFilters = !!(debouncedSearchEmail || debouncedSearchName || debouncedFilterStatus || debouncedFilterList || debouncedDateFrom || debouncedDateTo)

  const clearFilters = () => {
    setSearchEmail('')
    setSearchName('')
    setFilterStatus('')
    setFilterList('')
    setDateFrom('')
    setDateTo('')
    setCurrentPage(1)
  }

  // Build the contacts query with all server-pushable filters applied.
  // - searchEmail matches email (case-insensitive .ilike())
  // - searchName matches name (.ilike())
  // - filterStatus exact match
  // - filterList exact match
  // - dateFrom / dateTo use .gte() and .lte() on created_at
  const buildContactsQuery = (membershipTenantId: string) => {
    let q = supabase
      .from('contacts')
      .select('*', { count: 'exact' })
      .eq('tenant_id', membershipTenantId)
      .order('created_at', { ascending: false })

    if (debouncedSearchEmail.trim()) {
      const term = debouncedSearchEmail.trim()
      if (exactMatch) {
        q = q.eq('email', term.toLowerCase())
      } else {
        q = q.ilike('email', `%${term}%`)
      }
    }
    if (debouncedSearchName.trim()) {
      const term = debouncedSearchName.trim()
      if (exactMatch) {
        q = q.ilike('name', term) // exact match on name still uses ilike since NULL handling differs
      } else {
        q = q.ilike('name', `%${term}%`)
      }
    }
    if (debouncedFilterStatus) {
      q = q.eq('status', debouncedFilterStatus)
    }
    if (debouncedFilterList) {
      q = q.eq('list_id', debouncedFilterList)
    }
    if (debouncedDateFrom) {
      q = q.gte('created_at', new Date(debouncedDateFrom + 'T00:00:00').toISOString())
    }
    if (debouncedDateTo) {
      q = q.lte('created_at', new Date(debouncedDateTo + 'T23:59:59').toISOString())
    }
    return q
  }

  // Fetch ONE page of contacts (size = CONTACTS_PER_PAGE) + total count.
  // Uses a `cancelled` flag so fast page/filter changes don't race.
  const fetchPage = async (page: number, membershipTenantId: string, opts: { silent?: boolean } = {}) => {
    const { silent } = opts
    if (!silent) setLoading(true)

    const from = (page - 1) * CONTACTS_PER_PAGE
    const to = from + CONTACTS_PER_PAGE - 1

    try {
      const { data: pageRows, error: pageErr, count } = await buildContactsQuery(membershipTenantId).range(from, to)
      if (pageErr) throw pageErr
      setContacts((pageRows || []) as Contact[])
      if (count !== null && count !== undefined) setTotalCount(count)
    } catch (err) {
      console.error('Failed to load contacts page:', err)
    } finally {
      if (!silent) setLoading(false)
    }
  }

  // Initial mount + tenant resolution + lists load (lists are small).
  useEffect(() => {
    let cancelled = false
    const init = async () => {
      setLoading(true)
      const { data: membership } = await supabase.from('memberships').select('tenant_id').eq('user_id', session.user.id).single()
      if (cancelled) return
      if (!membership) { setLoading(false); return }
      setTenantId(membership.tenant_id)

      // Lists are small (<100 rows usually) so load them in full once.
      const { data: listData } = await supabase
        .from('lists')
        .select('*')
        .eq('tenant_id', membership.tenant_id)
        .order('name')
      if (cancelled) return
      setLists((listData || []) as ContactList[])

      await fetchPage(1, membership.tenant_id)
      if (cancelled) return
    }
    init()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.user.id, refreshListsKey])

  // Re-fetch when page or any filter changes.
  useEffect(() => {
    if (!tenantId) return
    let cancelled = false
    const refetch = async () => {
      await fetchPage(currentPage, tenantId, { silent: true })
      if (cancelled) return
    }
    refetch()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, currentPage, debouncedSearchEmail, debouncedSearchName, debouncedFilterStatus, debouncedFilterList, debouncedDateFrom, debouncedDateTo])

  // When filterListId is set from the parent (clicking a list count in
  // the Lists tab), apply it as a filter and reset to page 1.
  useEffect(() => {
    if (filterListId) {
      setFilterList(filterListId)
      setCurrentPage(1)
    }
  }, [filterListId])

  const handleAddContact = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newEmail) return

    const { data: membership } = await supabase.from('memberships').select('tenant_id').eq('user_id', session.user.id).single()
    if (!membership) return

    const { data: existing } = await supabase
      .from('contacts')
      .select('id, name, status, list_id')
      .eq('tenant_id', membership.tenant_id)
      .eq('email', newEmail.toLowerCase())
      .single()

    if (existing) {
      const updates: Record<string, unknown> = {}
      const newNameVal = newName.trim() || null
      const newListIdVal = newListId || null
      
      if (newNameVal !== existing.name) updates.name = newNameVal
      if (newStatus !== existing.status) updates.status = newStatus
      if (newListIdVal !== existing.list_id) updates.list_id = newListIdVal

      if (Object.keys(updates).length > 0) {
        console.log('Updating contact with:', updates)
        const { error } = await supabase.from('contacts').update(updates).eq('id', existing.id)
        if (error) {
          alert(`Failed to update contact: ${errorMessage(error)}`)
          return
        }
      }
    } else {
      const { error } = await supabase.from('contacts').insert({
        tenant_id: membership.tenant_id,
        email: newEmail.toLowerCase(),
        name: newName.trim() || null,
        status: newStatus,
        list_id: newListId || null,
      })
      if (error) {
        alert(`Failed to add contact: ${errorMessage(error)}`)
        return
      }
    }

    setNewEmail('')
    setNewName('')
    setNewStatus('subscribed')
    setNewListId('')
    // Re-fetch the current page to reflect the new/updated contact.
    if (tenantId) await fetchPage(currentPage, tenantId, { silent: true })
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete contact?')) return
    const { error } = await supabase.from('contacts').delete().eq('id', id)
    if (error) {
      alert(`Failed to delete contact: ${errorMessage(error)}`)
      return
    }
    // Re-fetch the current page (or page 1 if we deleted the last row on a
    // trailing page).
    if (tenantId) {
      const newTotal = Math.max(0, totalCount - 1)
      const newPage = Math.min(currentPage, Math.max(1, Math.ceil(newTotal / CONTACTS_PER_PAGE)))
      setCurrentPage(newPage)
      await fetchPage(newPage, tenantId, { silent: true })
    }
  }

  // Parse entire CSV text into rows, handling multi-line quoted fields per RFC 4180
  const parseCSVText = (text: string): string[][] => {
    const rows: string[][] = []
    let currentRow: string[] = []
    let currentField = ''
    let inQuotes = false
    let i = 0

    while (i < text.length) {
      const ch = text[i]

      if (inQuotes) {
        if (ch === '"') {
          // Check for escaped quote ("")
          if (i + 1 < text.length && text[i + 1] === '"') {
            currentField += '"'
            i += 2
            continue
          } else {
            inQuotes = false // end of quoted field
            i++
            continue
          }
        } else {
          currentField += ch
          i++
          continue
        }
      }

      // Not in quotes
      if (ch === '"') {
        inQuotes = true
        i++
        continue
      } else if (ch === ',') {
        currentRow.push(currentField.trim())
        currentField = ''
        i++
        continue
      } else if (ch === '\r') {
        // Handle \r\n or lone \r
        currentRow.push(currentField.trim())
        currentField = ''
        rows.push(currentRow)
        currentRow = []
        i++
        if (i < text.length && text[i] === '\n') i++ // skip \n after \r
        continue
      } else if (ch === '\n') {
        currentRow.push(currentField.trim())
        currentField = ''
        rows.push(currentRow)
        currentRow = []
        i++
        continue
      } else {
        currentField += ch
        i++
        continue
      }
    }

    // Handle last field/row (file may not end with newline)
    if (currentField || currentRow.length > 0) {
      currentRow.push(currentField.trim())
      rows.push(currentRow)
    }

    return rows
  }

  // Maximum number of contact rows accepted in a single CSV upload.
  // Larger files are rejected up-front with a clear message so the user
  // can split the file. The previous implementation had no cap and processed
  // rows one-by-one (1 SELECT + 1 INSERT per row = ~2s for 500 rows).
  // With batching + a 500-row cap, a max upload completes in ~1-2 seconds.
  const MAX_CONTACTS_PER_UPLOAD = 500
  // PostgREST default INSERT body cap is ~1MB; 100 rows of UUID + small
  // fields is well under that. Using chunks of 100 also avoids any
  // row-limit issues in the Supabase gateway.
  const CONTACT_INSERT_CHUNK = 100

  const handleBulkUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setUploading(true)
    try {
      const text = await file.text()
      const rows = parseCSVText(text).filter(r => r.some(c => c)) // remove completely blank rows
      if (rows.length < 2) {
        alert('CSV file is empty or has no data rows')
        setUploading(false)
        return
      }

      const header = rows[0].map(h => h.toLowerCase().trim())
      const emailIdx = header.indexOf('email')
      const nameIdx = header.indexOf('name')
      const statusIdx = header.indexOf('status')
      const listIdx = header.indexOf('list')

      if (emailIdx === -1) {
        alert('CSV must have an "email" column')
        setUploading(false)
        return
      }

      const { data: membership } = await supabase.from('memberships').select('tenant_id').eq('user_id', session.user.id).single()
      if (!membership) { setUploading(false); return }

      const listNameToId: Record<string, string> = {}
      lists.forEach(l => { listNameToId[l.name.toLowerCase()] = l.id })

      // Build contact records from CSV rows, dedup by email (last wins),
      // and enforce the MAX_CONTACTS_PER_UPLOAD cap.
      const contactMap = new Map<string, { email: string; name: string | null; status: string; list_id: string | null }>()
      for (let i = 1; i < rows.length; i++) {
        const cols = rows[i]
        const email = cols[emailIdx]?.toLowerCase().trim()
        if (!email) continue

        const name = nameIdx !== -1 ? (cols[nameIdx]?.trim() || null) : null
        const statusVal = statusIdx !== -1 ? (cols[statusIdx]?.toLowerCase().trim() || 'subscribed') : 'subscribed'
        const validStatus = ['subscribed', 'unsubscribed', 'hardbounced'].includes(statusVal) ? statusVal : 'subscribed'
        const listName = listIdx !== -1 ? cols[listIdx]?.toLowerCase().trim() : null
        const listId = listName ? listNameToId[listName] || null : null

        contactMap.set(email, { email, name, status: validStatus, list_id: listId })
      }

      const dataRows = Array.from(contactMap.values())

      if (dataRows.length > MAX_CONTACTS_PER_UPLOAD) {
        alert(
          `CSV contains ${dataRows.length} contacts, which exceeds the ` +
          `maximum of ${MAX_CONTACTS_PER_UPLOAD} per upload.\n\n` +
          `Please split the file into smaller batches of ${MAX_CONTACTS_PER_UPLOAD} ` +
          `or fewer contacts and upload them one at a time.`
        )
        setUploading(false)
        return
      }

      if (dataRows.length === 0) {
        alert('No valid contact rows found in CSV (need an "email" column with at least one row).')
        setUploading(false)
        return
      }

      // Batch-fetch existing contacts by email (chunked .in() because
      // PostgREST .in() has a URL length limit). This replaces the prior
      // per-row SELECT that turned into 500 sequential round-trips.
      const allEmails = dataRows.map(c => c.email)
      const existingMap = new Map<string, { id: string; name: string | null; status: string; list_id: string | null }>()
      for (const chunk of chunkArray(allEmails, POSTGREST_IN_CHUNK)) {
        const { data: existingRows } = await supabase
          .from('contacts')
          .select('id, email, name, status, list_id')
          .eq('tenant_id', membership.tenant_id)
          .in('email', chunk)
        if (existingRows) {
          existingRows.forEach((r: { id: string; email: string; name: string | null; status: string; list_id: string | null }) => {
            existingMap.set(r.email.toLowerCase(), { id: r.id, name: r.name, status: r.status, list_id: r.list_id })
          })
        }
      }

      const toInsert: { tenant_id: string; email: string; name: string | null; status: string; list_id: string | null }[] = []
      const toUpdate: { id: string; patch: Record<string, unknown> }[] = []

      for (const c of dataRows) {
        const existing = existingMap.get(c.email)
        if (existing) {
          const updates: Record<string, unknown> = {}
          if (c.name !== existing.name) updates.name = c.name
          if (c.status !== existing.status) updates.status = c.status
          if (c.list_id !== existing.list_id) updates.list_id = c.list_id
          if (Object.keys(updates).length > 0) {
            toUpdate.push({ id: existing.id, patch: updates })
          }
        } else {
          toInsert.push({
            tenant_id: membership.tenant_id,
            email: c.email,
            name: c.name,
            status: c.status,
            list_id: c.list_id,
          })
        }
      }

      let added = 0
      let updated = 0
      let firstInsertError: string | null = null
      let firstUpdateError: string | null = null

      // Batch INSERT -- one round-trip per chunk of 100, vs the prior
      // 500 sequential single-row INSERTs.
      for (const chunk of chunkArray(toInsert, CONTACT_INSERT_CHUNK)) {
        const { error } = await supabase.from('contacts').insert(chunk)
        if (error) {
          if (!firstInsertError) firstInsertError = error.message
          break
        }
        added += chunk.length
      }

      // Updates are still per-row because each one targets a different id
      // with a different patch. They are fired off in parallel chunks
      // (Promise.all) so total wall time is roughly ceil(N/CHUNK) RTTs
      // instead of N.
      const updateChunks = chunkArray(toUpdate, CONTACT_INSERT_CHUNK)
      for (const chunk of updateChunks) {
        const results = await Promise.all(
          chunk.map(u => supabase.from('contacts').update(u.patch).eq('id', u.id))
        )
        for (const r of results) {
          if (r.error) {
            if (!firstUpdateError) firstUpdateError = r.error.message
          } else {
            updated++
          }
        }
      }

      let msg = `Import complete: ${added} added, ${updated} updated`
      if (firstInsertError) msg += `\n\nSome inserts failed: ${firstInsertError}`
      if (firstUpdateError) msg += `\n\nSome updates failed: ${firstUpdateError}`
      alert(msg)
      // Re-fetch the current page so newly-added contacts appear.
      if (tenantId) await fetchPage(currentPage, tenantId, { silent: true })
    } catch (err) {
      alert(`Import failed: ${errorMessage(err)}`)
    }
    setUploading(false)
    e.target.value = ''
  }

  const downloadTemplate = () => {
    // BOM + CRLF keep Excel happy with encoding and line endings.
    const csv = '\uFEFFemail,name,status,list\r\njohn@example.com,John Doe,subscribed,My List\r\njane@example.com,Jane Smith,subscribed,'
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'contacts-template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const downloadContactsCSV = async () => {
    // CSV export fetches ALL matching contacts via paginated .range()
    // using the same server-side filters the table uses. Without this,
    // the export would only contain the 10 rows on the visible page.
    // Same two modes as History: filters active -> filtered export,
    // no filters -> entire contact list.
    setExporting(true)

    try {
      if (!tenantId) {
        alert('Tenant not loaded yet — please try again in a moment.')
        return
      }

      // Paginate through .range() to bypass the PostgREST 1000-row cap.
      // buildContactsQuery already includes the count selector, so we
      // reuse it and just call .range() repeatedly.
      const allContacts: Contact[] = []
      const PAGE = 1000
      let from = 0
      while (true) {
        const { data, error } = await buildContactsQuery(tenantId).range(from, from + PAGE - 1)
        if (error) throw error
        if (!data || data.length === 0) break
        allContacts.push(...(data as Contact[]))
        if (data.length < PAGE) break
        from += PAGE
      }

      if (allContacts.length === 0) {
        alert('No contacts to download.')
        return
      }

      const header = 'email,name,status,list'
      const rows = allContacts.map(c => {
        const listName = c.list_id ? (lists.find(l => l.id === c.list_id)?.name || '') : ''
        return `${csvEscape(c.email)},${csvEscape(c.name || '')},${csvEscape(c.status)},${csvEscape(listName)}`
      })
      // UTF-8 BOM so Excel detects non-ASCII names correctly; CRLF endings
      // are the safest form for Excel's CSV/text importer.
      const csv = '\uFEFF' + [header, ...rows].join('\r\n')
      const blob = new Blob([csv], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const filterLabel = hasFilters ? 'filtered' : 'all'
      a.download = `contacts-${filterLabel}-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Contacts CSV export failed:', err)
      alert(`Contacts CSV export failed: ${errorMessage(err)}`)
    } finally {
      setExporting(false)
    }
  }

  // Derived pagination values for the visible page. With server-side
  // pagination, `totalCount` is the canonical total (returned by Supabase
  // via { count: 'exact' }), and `contacts` holds just the 10 visible
  // rows for the current page.
  const totalContacts = totalCount
  const totalPages = Math.max(1, Math.ceil(totalContacts / CONTACTS_PER_PAGE))
  const showingFrom = totalContacts === 0 ? 0 : (currentPage - 1) * CONTACTS_PER_PAGE + 1
  const showingTo = Math.min(currentPage * CONTACTS_PER_PAGE, totalContacts)

  const handlePrevPage = () => {
    if (currentPage > 1) setCurrentPage(currentPage - 1)
  }

  const handleNextPage = () => {
    if (currentPage < totalPages) setCurrentPage(currentPage + 1)
  }

  const deleteFilteredContacts = async () => {
    // Fetch ALL contact IDs matching the current filters (paginated to
    // bypass the 1000-row PostgREST cap). For "Delete All" with no
    // filters, this fetches every contact ID in the tenant — the in-
    // memory list only holds 10 rows now, so we can't read IDs from it.
    if (!tenantId) return
    let contactIds: string[] = []
    try {
      // Use the same query shape as buildContactsQuery but select only id.
      let q = supabase.from('contacts').select('id').eq('tenant_id', tenantId)
      if (debouncedSearchEmail.trim()) {
        const term = debouncedSearchEmail.trim()
        q = exactMatch ? q.eq('email', term.toLowerCase()) : q.ilike('email', `%${term}%`)
      }
      if (debouncedSearchName.trim()) {
        const term = debouncedSearchName.trim()
        q = exactMatch ? q.ilike('name', term) : q.ilike('name', `%${term}%`)
      }
      if (debouncedFilterStatus) q = q.eq('status', debouncedFilterStatus)
      if (debouncedFilterList) q = q.eq('list_id', debouncedFilterList)
      if (debouncedDateFrom) q = q.gte('created_at', new Date(debouncedDateFrom + 'T00:00:00').toISOString())
      if (debouncedDateTo) q = q.lte('created_at', new Date(debouncedDateTo + 'T23:59:59').toISOString())
      const allRows = await fetchAllPaginated<{ id: string }>(q)
      contactIds = allRows.map(r => r.id)
    } catch (err) {
      alert(`Failed to list contacts for deletion: ${errorMessage(err)}`)
      return
    }

    if (contactIds.length === 0) {
      setShowDeleteModal(false)
      return
    }

    // Chunk the .in() filter -- PostgREST .in() is URL-encoded and
    // exceeds the 8KB URL limit around ~300 UUIDs. Chunking to 200
    // keeps every request safely under the limit.
    let firstError: string | null = null
    for (const chunk of chunkArray(contactIds, POSTGREST_IN_CHUNK)) {
      const { error } = await supabase.from('contacts').delete().in('id', chunk)
      if (error && !firstError) firstError = error.message
    }
    if (firstError) {
      alert(`Some deletes failed: ${firstError}. Refresh the list to see remaining records.`)
    }
    setShowDeleteModal(false)
    // After delete, re-fetch page 1 (current page may no longer exist).
    setCurrentPage(1)
    await fetchPage(1, tenantId, { silent: false })
  }

  const getListName = (listId: string | null) => {
    if (!listId) return '-'
    const list = lists.find(l => l.id === listId)
    return list?.name || '-'
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'subscribed': return 'bg-green-100 text-green-800'
      case 'unsubscribed': return 'bg-yellow-100 text-yellow-800'
      case 'hardbounced': return 'bg-red-100 text-red-800'
      default: return 'bg-gray-100 text-gray-800'
    }
  }

  return (
    <>
    <div className="bg-white p-6 rounded shadow">
      <form onSubmit={handleAddContact} className="flex flex-wrap gap-2 mb-4 p-3 bg-gray-50 rounded">
        <input type="email" placeholder="Email" value={newEmail} onChange={e => setNewEmail(e.target.value)} className="border p-2 rounded flex-1 min-w-48" required />
        <input type="text" placeholder="Name (optional)" value={newName} onChange={e => setNewName(e.target.value)} className="border p-2 rounded w-32" />
        <select value={newStatus} onChange={e => setNewStatus(e.target.value)} className="border p-2 rounded">
          <option value="subscribed">Subscribed</option>
          <option value="unsubscribed">Unsubscribed</option>
          <option value="hardbounced">Hard Bounced</option>
        </select>
        <select value={newListId} onChange={e => setNewListId(e.target.value)} className="border p-2 rounded">
          <option value="">No List</option>
          {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded">Add Contact</button>
      </form>

      <div className="flex gap-2 mb-2 items-center flex-wrap">
        <label className="bg-green-600 text-white px-4 py-2 rounded cursor-pointer hover:bg-green-700">
          {uploading ? 'Uploading...' : 'Upload CSV'}
          <input type="file" accept=".csv" onChange={handleBulkUpload} className="hidden" disabled={uploading} />
        </label>
        <button
          onClick={downloadContactsCSV}
          disabled={exporting}
          title={hasFilters
            ? 'Export every contact matching the current filters'
            : 'Export all contacts'}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-60"
        >
          {exporting ? 'Preparing CSV...' : 'Download CSV'}
        </button>
        <button onClick={downloadTemplate} className="text-blue-600 hover:underline text-sm">
          Download Template
        </button>
        <span className="text-xs text-gray-500 ml-auto">
          Max {MAX_CONTACTS_PER_UPLOAD} contacts per upload · CSV must have an <code className="bg-gray-100 px-1 rounded">email</code> column
        </span>
      </div>

      <div className="flex flex-wrap gap-2 mb-4 items-center">
        <input
          type="text"
          placeholder="Search email..."
          value={searchEmail}
          onChange={e => { setSearchEmail(e.target.value); setCurrentPage(1) }}
          className="border p-2 rounded text-sm w-40"
        />
        <input
          type="text"
          placeholder="Search name..."
          value={searchName}
          onChange={e => { setSearchName(e.target.value); setCurrentPage(1) }}
          className="border p-2 rounded text-sm w-32"
        />
        <input
          id="exactMatchContact"
          type="checkbox"
          checked={exactMatch}
          onChange={e => setExactMatch(e.target.checked)}
        />
        <label htmlFor="exactMatchContact" className="text-sm">Exact</label>
        {totalCount > 0 && (
          <button onClick={() => setShowDeleteModal(true)} className="bg-red-600 text-white px-3 py-2 rounded text-sm hover:bg-red-700">
            {hasFilters ? `Delete Filtered` : `Delete All`}
          </button>
        )}
        <select value={filterStatus} onChange={e => { setFilterStatus(e.target.value); setCurrentPage(1) }} className="border p-2 rounded text-sm">
          <option value="">All Status</option>
          <option value="subscribed">Subscribed</option>
          <option value="unsubscribed">Unsubscribed</option>
          <option value="hardbounced">Hard Bounced</option>
        </select>
        <select value={filterList} onChange={e => { setFilterList(e.target.value); setCurrentPage(1) }} className="border p-2 rounded text-sm">
          <option value="">All Lists</option>
          {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setCurrentPage(1) }} className="border p-2 rounded text-sm" />
        <span className="text-gray-500">to</span>
        <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setCurrentPage(1) }} className="border p-2 rounded text-sm" />
        {hasFilters && (
          <button onClick={clearFilters} className="text-red-600 hover:underline text-sm">Clear</button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <svg className="animate-spin h-5 w-5 mr-3 text-blue-500" fill="none" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
            <path fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          Loading contacts...
        </div>
      ) : (
        <>
          <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="text-left p-2">Email</th>
              <th className="text-left p-2">Name</th>
              <th className="text-left p-2">Status</th>
              <th className="text-left p-2">List</th>
              <th className="text-left p-2">Added Date</th>
              <th className="text-left p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map(c => (
              <tr key={c.id} className="border-b">
                <td className="p-2">{c.email}</td>
                <td className="p-2">{c.name || '-'}</td>
                <td className="p-2">
                  <span className={`px-2 py-1 rounded-full text-xs ${getStatusColor(c.status)}`}>
                    {c.status}
                  </span>
                </td>
                <td className="p-2">{getListName(c.list_id)}</td>
                <td className="p-2">{new Date(c.created_at).toLocaleDateString()}</td>
                <td className="p-2">
                  <button onClick={() => handleDelete(c.id)} className="text-red-600 text-xs hover:underline">Delete</button>
                </td>
              </tr>
            ))}
            {contacts.length === 0 && <tr><td colSpan={6} className="p-4 text-center">{hasFilters ? 'No contacts match your filters.' : 'No contacts yet.'}</td></tr>}
          </tbody>
        </table>
        {totalPages >= 1 && (
          <div className="flex justify-between items-center mt-4 pt-3 border-t">
            <span className="text-sm text-gray-500">
              Showing {showingFrom}-{showingTo} of {totalContacts}
            </span>
            <div className="flex items-center gap-2">
              <button onClick={handlePrevPage} disabled={currentPage === 1} className="px-3 py-1 text-sm border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50">← Previous</button>
              <span className="text-sm">Page {currentPage} of {totalPages}</span>
              <button onClick={handleNextPage} disabled={currentPage === totalPages || totalPages === 0} className="px-3 py-1 text-sm border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50">Next →</button>
            </div>
          </div>
        )}
        </>
      )}
    </div>

    {/* Delete Confirmation Modal */}
    {showDeleteModal && (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
          <h3 className="text-lg font-bold text-red-600 mb-3">Confirm Deletion</h3>
          <p className="text-gray-700 mb-2">
            {hasFilters
              ? `You are about to delete ALL contacts matching your current filters (status, list, date, search). The deletion will fetch and remove every matching contact in the tenant, not just the visible page.`
              : `You are about to delete ALL ${totalCount} contact(s) in this tenant. This will fetch and remove every contact, not just the visible page.`}
          </p>
          <p className="text-sm text-red-600 font-medium mb-4">This action cannot be undone.</p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setShowDeleteModal(false)}
              className="px-4 py-2 border border-gray-300 rounded text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={deleteFilteredContacts}
              className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
            >
              Yes, Delete
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}

interface EmailSend {
  id: string
  tracking_id: string
  recipient_email: string
  subject: string
  status: string
  sent_at: string | null
  send_at: string | null
  created_at: string
  open_count: number
  click_count: number
}

interface Attachment {
  id: string
  send_id: string
  file_name: string
  storage_path: string
}

interface EmailEvent {
  id: string
  send_id: string
  event_type: string
  clicked_url: string | null
  created_at: string
}

function HistoryTab({ session }: { session: Session }) {
  const BUCKET_NAME = 'dfsdfsdf'
  // Server-side pagination state: we only ever hold ONE page of sends
  // (size = SENDS_PER_PAGE) in memory at a time. The previous
  // implementation loaded 500 rows + their attachments + their events,
  // which for an active campaign with 11,744 email_events rows meant
  // thousands of events flowing across the wire on every tab mount —
  // taking 5-30 seconds and frequently appearing "stuck in loading".
  //
  // The csv-chat-vercel repo's pattern is the right model: only fetch
  // the visible page of rows via .range(from, to), fetch the total
  // count via { count: 'exact', head: true } in parallel, fetch the
  // related attachments/events/contact-names only for those visible
  // IDs, and use a `cancelled` flag so a fast page change doesn't
  // race with a stale fetch.
  const SENDS_PER_PAGE = 10

  const [sends, setSends] = useState<EmailSend[]>([])
  const [attachments, setAttachments] = useState<Record<string, Attachment[]>>({})
  const [events, setEvents] = useState<Record<string, EmailEvent[]>>({})
  const [totalCount, setTotalCount] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [searchEmail, setSearchEmail] = useState('')
  const [searchFile, setSearchFile] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [tenantId, setTenantId] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [exporting, setExporting] = useState(false)

  // Debounce search inputs so we don't fire a Supabase query on every
  // keystroke. 350ms is the same default csv-chat-vercel uses.
  const [debouncedSearchEmail, setDebouncedSearchEmail] = useState('')
  const [debouncedSearchFile, setDebouncedSearchFile] = useState('')
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearchEmail(searchEmail)
      setDebouncedSearchFile(searchFile)
    }, 350)
    return () => clearTimeout(t)
  }, [searchEmail, searchFile])

  const hasFilters = !!(debouncedSearchEmail || debouncedSearchFile || dateFrom || dateTo)

  const clearFilters = () => {
    setSearchEmail('')
    setSearchFile('')
    setDateFrom('')
    setDateTo('')
    setCurrentPage(1)
  }

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id)
  }

  const formatIST = (dateStr: string | null | undefined): string => {
    if (!dateStr) return ''
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return ''
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).replace(/\//g, '-')
  }

  // Build the email_sends query with all server-pushable filters applied.
  // - searchEmail matches recipient_email OR subject (case-insensitive .or().ilike())
  // - dateFrom / dateTo use .gte() and .lte() on created_at
  // - searchFile stays client-side for now (no join available client-side),
  //   but we still load attachments for the visible page so the user can
  //   see file names and the client-side filter works on those 10 rows.
  //
  // `columns` lets the CSV export request ONLY the fields it needs (see
  // downloadCSV): email_sends rows carry ~58KB of html_content each, so
  // select=* at 1000 rows/page moves ~58MB per request and trips the
  // Postgres statement timeout (error 57014).
  const buildSendsQuery = (membershipTenantId: string, columns = '*') => {
    let q = supabase
      .from('email_sends')
      .select(columns, { count: 'exact' })
      .eq('tenant_id', membershipTenantId)
      .order('created_at', { ascending: false })

    if (debouncedSearchEmail.trim()) {
      // .or() with .ilike() filters email OR subject on the same query
      const term = debouncedSearchEmail.trim().toLowerCase()
      q = q.or(`recipient_email.ilike.%${term}%,subject.ilike.%${term}%`)
    }
    if (dateFrom) {
      // created_at >= start of dateFrom (00:00:00 local)
      q = q.gte('created_at', new Date(dateFrom + 'T00:00:00').toISOString())
    }
    if (dateTo) {
      // created_at <= end of dateTo (23:59:59 local)
      q = q.lte('created_at', new Date(dateTo + 'T23:59:59').toISOString())
    }
    return q
  }

  // Fetch ONE page of email_sends (size = SENDS_PER_PAGE) + the total
  // count + attachments/events/contact-names for only those rows.
  // Uses a `cancelled` flag so a fast page/filter change doesn't race
  // with a stale fetch and write stale state.
  const fetchPage = async (page: number, membershipTenantId: string, opts: { silent?: boolean } = {}) => {
    const { silent } = opts
    if (!silent) setLoading(true)

    const from = (page - 1) * SENDS_PER_PAGE
    const to = from + SENDS_PER_PAGE - 1

    try {
      // Parallel: visible-page rows + total count (same query, count via head)
      const sendsQuery = buildSendsQuery(membershipTenantId).range(from, to)
      const { data: pageRows, error: pageErr, count } = await sendsQuery
      if (pageErr) throw pageErr

      const rows = (pageRows || []) as unknown as EmailSend[]
      if (count !== null && count !== undefined) setTotalCount(count)

      // If a searchFile filter is active, filter client-side on the 10
      // loaded rows. This matches the prior behaviour for the visible
      // page (file-name join isn't possible client-side).
      let visibleRows = rows
      if (debouncedSearchFile.trim()) {
        // We can only apply this filter after attachments are loaded,
        // so we'll set sends now and filter the visible rows below.
      }

      setSends(visibleRows)

      // Fetch related data only for the 10 visible send IDs. This is
      // the key win: 1 round-trip per related table instead of 3 chunks
      // of 200 IDs each.
      const sendIds = visibleRows.map(s => s.id)
      if (sendIds.length > 0) {
        // Chunked + paginated + errors surfaced. The prior single .in()
        // query silently truncated at PostgREST's 1000-row cap when the
        // visible page's sends had many combined events, and query errors
        // were discarded entirely (`const { data }` with no error check),
        // so a failed fetch looked like "no activity".
        try {
          const [atts, evts] = await Promise.all([
            fetchAllForSends<Attachment>('send_attachments', sendIds),
            fetchAllForSends<EmailEvent>('email_events', sendIds),
          ])
          const attMap: Record<string, Attachment[]> = {}
          atts.forEach((a: Attachment) => {
            if (!attMap[a.send_id]) attMap[a.send_id] = []
            attMap[a.send_id].push(a)
          })
          setAttachments(attMap)

          const evtMap: Record<string, EmailEvent[]> = {}
          evts.forEach((e: EmailEvent) => {
            if (!evtMap[e.send_id]) evtMap[e.send_id] = []
            evtMap[e.send_id].push(e)
          })
          setEvents(evtMap)
        } catch (err) {
          console.error('Failed to load page attachments/events:', err)
          alert(`Failed to load activity data for this page: ${errorMessage(err)}`)
        }
        // Note: contact names are not fetched here — the History table
        // shows recipient_email (from the email_sends row directly),
        // not contact names. The CSV export builds its own name lookup
        // on-demand for all matching rows.
      } else {
        setAttachments({})
        setEvents({})
      }
    } catch (err) {
      console.error('Failed to load history page:', err)
    } finally {
      if (!silent) setLoading(false)
    }
  }

  // Initial mount + tenant resolution.
  useEffect(() => {
    let cancelled = false
    const init = async () => {
      setLoading(true)
      const { data: membership } = await supabase
        .from('memberships')
        .select('tenant_id')
        .eq('user_id', session.user.id)
        .single()
      if (cancelled) return
      if (!membership) { setLoading(false); return }
      setTenantId(membership.tenant_id)
      await fetchPage(1, membership.tenant_id)
      if (cancelled) return
    }
    init()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.user.id])

  // Re-fetch when page or any server-pushable filter changes.
  useEffect(() => {
    if (!tenantId) return
    let cancelled = false
    const refetch = async () => {
      // For filter changes we want to keep the spinner subtle — the user
      // is actively typing/searching, so we use silent mode (no full-screen
      // loading state, just inline).
      await fetchPage(currentPage, tenantId, { silent: true })
      if (cancelled) return
    }
    refetch()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, currentPage, debouncedSearchEmail, debouncedSearchFile, dateFrom, dateTo])

  // Derived pagination values for the visible page.
  const totalSends = totalCount
  const totalPages = Math.max(1, Math.ceil(totalSends / SENDS_PER_PAGE))
  const showingFrom = totalSends === 0 ? 0 : (currentPage - 1) * SENDS_PER_PAGE + 1
  const showingTo = Math.min(currentPage * SENDS_PER_PAGE, totalSends)

  // Apply the client-side searchFile filter to the loaded rows. If a
  // file filter is active and the visible page has 0 matching rows,
  // the user will see an empty list — they can use the page nav to
  // scan more pages. (Server-side file-name filter would require a
  // join that the Supabase JS client can't express without an RPC.)
  const visibleFilteredSends = debouncedSearchFile.trim()
    ? sends.filter(s => {
        const atts = attachments[s.id] || []
        const fileNames = atts.map(a => a.file_name).join(' ').toLowerCase()
        return fileNames.includes(debouncedSearchFile.toLowerCase())
      })
    : sends

  const handlePrevPage = () => {
    if (currentPage > 1) setCurrentPage(currentPage - 1)
  }

  const handleNextPage = () => {
    if (currentPage < totalPages) setCurrentPage(currentPage + 1)
  }

  const downloadCSV = async () => {
    // CSV export runs in TWO modes (mirroring the Delete button):
    //   - Filters active  -> export EVERY record matching the current
    //     search / file / date filters (the full filtered result set,
    //     not just the 10 visible rows).
    //   - No filters      -> export the ENTIRE history.
    // All matching rows are re-fetched via paginated .range() calls
    // (bypassing the PostgREST 1000-row cap), then attachments, events
    // and contact names are joined in so the CSV carries the same
    // columns as the visible table.
    //
    // ⚠ Slim columns are mandatory here: email_sends.html_content
    // averages ~58KB per row, so select=* at 1000 rows/page used to
    // move ~58MB per request and die with a Postgres statement timeout
    // (57014), which surfaced to the user as "[object Object]". The
    // slim column list keeps every page well under 300KB.
    setExporting(true)

    try {
      if (!tenantId) {
        alert('Tenant not loaded yet — please try again in a moment.')
        return
      }

      const PAGE = 1000 // PostgREST hard cap per page
      const MAX_ROWS = 1_000_000 // hard stop against an infinite loop
      const SEND_COLUMNS =
        'id,created_at,recipient_email,subject,status,open_count,click_count'

      // 1. Fetch ALL matching email_sends (slim columns) via paginated .range().
      const allSends: EmailSend[] = []
      let from = 0
      while (from < MAX_ROWS) {
        const { data, error } = await buildSendsQuery(tenantId, SEND_COLUMNS)
          .range(from, from + PAGE - 1)
        if (error) throw error
        if (!data || data.length === 0) break
        allSends.push(...(data as unknown as EmailSend[]))
        if (data.length < PAGE) break
        from += PAGE
      }

      if (allSends.length === 0) {
        alert(hasFilters
          ? 'No records match the current filters — nothing to export.'
          : 'History is empty — nothing to export.')
        return
      }

      // 2. Fetch attachments + events for ALL those send IDs, chunked to
      //    stay under the .in() URL length limit. Each chunk query is
      //    ALSO paginated with an inner .range() loop, because PostgREST
      //    caps every SELECT at 1000 rows and a 200-send chunk can hold
      //    far more events than that (the old code silently truncated,
      //    dropping opens/clicks from the "All Events" column).
      const allIds = allSends.map(s => s.id)
      const fetchRelatedForChunks = async (
        table: 'send_attachments' | 'email_events'
      ): Promise<Record<string, Attachment[] | EmailEvent[]>> => {
        const map: Record<string, Attachment[] | EmailEvent[]> = {}
        for (const chunk of chunkArray(allIds, POSTGREST_IN_CHUNK)) {
          let chunkFrom = 0
          while (chunkFrom < MAX_ROWS) {
            let q = supabase.from(table).select('*').in('send_id', chunk)
            if (table === 'email_events') {
              q = q.order('created_at', { ascending: true })
            }
            const { data, error } = await q.range(chunkFrom, chunkFrom + PAGE - 1)
            if (error) throw error
            if (!data || data.length === 0) break
            for (const row of data as (Attachment & EmailEvent)[]) {
              if (!map[row.send_id]) map[row.send_id] = []
              map[row.send_id].push(row)
            }
            if (data.length < PAGE) break
            chunkFrom += PAGE
          }
        }
        return map
      }
      const [attMap, evtMap] = await Promise.all([
        fetchRelatedForChunks('send_attachments') as Promise<Record<string, Attachment[]>>,
        fetchRelatedForChunks('email_events') as Promise<Record<string, EmailEvent[]>>,
      ])

      // 3. Fetch contact names for the tenant (paginated). We pull all
      //    tenant contacts instead of .in(email, ...) matching because
      //    addresses are stored with mixed case and .in() compares
      //    case-sensitively — lowercased lookups used to silently miss.
      const nameMap: Record<string, string> = {}
      from = 0
      while (from < MAX_ROWS) {
        const { data, error } = await supabase
          .from('contacts')
          .select('email, name')
          .eq('tenant_id', tenantId)
          .range(from, from + PAGE - 1)
        if (error) throw error
        if (!data || data.length === 0) break
        for (const c of data as { email: string; name: string | null }[]) {
          if (c.name) nameMap[c.email.toLowerCase()] = c.name
        }
        if (data.length < PAGE) break
        from += PAGE
      }

      // 4. Apply the client-side searchFile filter (server can't push this).
      let dataToExport = allSends
      if (debouncedSearchFile.trim()) {
        dataToExport = allSends.filter(s => {
          const atts = attMap[s.id] || []
          const fileNames = atts.map(a => a.file_name).join(' ').toLowerCase()
          return fileNames.includes(debouncedSearchFile.toLowerCase())
        })
      }

      // 5. Build the CSV. All cells go through csvCell(): control chars
      //    stripped, 32k-capped, quote-escaped. Timestamps use csvIST()
      //    (space separator — commas inside values shred Excel imports).
      const headers = ['Date (IST)', 'Recipient Name', 'Recipient Email', 'Subject', 'Status', 'Attachments', 'Opens', 'Clicks', 'First Open (IST)', 'First Click (IST)', 'All Events']
      const rows = dataToExport.map(s => {
        const atts = attMap[s.id] || []
        const evtList = evtMap[s.id] || []
        const openEvents = evtList.filter(e => e.event_type === 'open')
        const clickEvents = evtList.filter(e => e.event_type === 'click')
        const firstOpen = openEvents.length > 0 ? csvIST(openEvents[0].created_at) : ''
        const firstClick = clickEvents.length > 0 ? csvIST(clickEvents[0].created_at) : ''
        const allEvents = buildAllEventsCell(evtList)
        return [
          csvIST(s.created_at),
          nameMap[s.recipient_email.toLowerCase()] || '',
          s.recipient_email,
          s.subject,
          s.status,
          atts.map(a => a.file_name).join('; '),
          String(s.open_count || 0),
          String(s.click_count || 0),
          firstOpen,
          firstClick,
          allEvents
        ].map(csvCell).join(',')
      })
      // UTF-8 BOM (Excel encoding detection) + CRLF line endings.
      const csv = '\uFEFF' + [headers.join(','), ...rows].join('\r\n')
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const suffix = hasFilters ? 'filtered' : 'all'
      a.download = `email-history-${suffix}-${new Date().toISOString().split('T')[0]}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('CSV export failed:', err)
      // errorMessage() unwraps plain PostgrestError objects so the user
      // sees the REAL cause (e.g. "canceling statement due to statement
      // timeout") instead of "[object Object]".
      alert(`CSV export failed: ${errorMessage(err)}`)
    } finally {
      setExporting(false)
    }
  }

  const deleteSingleRecord = async (id: string) => {
    if (!tenantId) return
    if (!confirm('Delete this record? This cannot be undone.')) return

    // Fetch attachment storage_paths BEFORE deleting the rows, so we can also
    // delete the actual file bytes from the storage bucket. Without this,
    // deleting a History record leaves orphan files in storage.
    const { data: attRows, error: attListErr } = await supabase
      .from('send_attachments')
      .select('storage_path')
      .eq('send_id', id)
    if (attListErr) { alert(`Failed: ${errorMessage(attListErr)}`); return }
    const pathsToRemove = (attRows || []).map(r => r.storage_path).filter(Boolean)

    const { error: evtErr } = await supabase.from('email_events').delete().eq('send_id', id)
    if (evtErr) { alert(`Failed: ${errorMessage(evtErr)}`); return }

    const { error: attErr } = await supabase.from('send_attachments').delete().eq('send_id', id)
    if (attErr) { alert(`Failed: ${errorMessage(attErr)}`); return }

    const { error: sendErr } = await supabase.from('email_sends').delete().eq('id', id).eq('tenant_id', tenantId)
    if (sendErr) { alert(`Failed: ${errorMessage(sendErr)}`); return }

    // Best-effort storage cleanup.
    if (pathsToRemove.length > 0) {
      const { error: storageErr } = await supabase.storage.from(BUCKET_NAME).remove(pathsToRemove)
      if (storageErr) console.error('Storage cleanup failed (rows already deleted):', storageErr)
    }

    // Re-fetch the current page to refill the slot left by the deleted row.
    await fetchPage(currentPage, tenantId, { silent: true })
    if (expandedId === id) setExpandedId(null)
  }

  const deleteRecords = async () => {
    if (!tenantId) return

    // Fetch ALL send IDs matching the current filters, paginated to bypass
    // the 1000-row PostgREST cap. We use .select('id') with the same
    // filter chain as buildSendsQuery so Delete respects search/date
    // filters exactly the way the table does.
    let deleteQuery = supabase
      .from('email_sends')
      .select('id')
      .eq('tenant_id', tenantId)

    if (debouncedSearchEmail.trim()) {
      const term = debouncedSearchEmail.trim().toLowerCase()
      deleteQuery = deleteQuery.or(`recipient_email.ilike.%${term}%,subject.ilike.%${term}%`)
    }
    if (dateFrom) {
      deleteQuery = deleteQuery.gte('created_at', new Date(dateFrom + 'T00:00:00').toISOString())
    }
    if (dateTo) {
      deleteQuery = deleteQuery.lte('created_at', new Date(dateTo + 'T23:59:59').toISOString())
    }

    let sendIds: string[] = []
    try {
      const allRows = await fetchAllPaginated<{ id: string }>(deleteQuery)
      sendIds = allRows.map(r => r.id)
    } catch (err) {
      alert(`Failed to list records for deletion: ${errorMessage(err)}`)
      return
    }

    if (sendIds.length === 0) {
      alert('No records to delete.')
      return
    }

    const confirmMsg = hasFilters
      ? `Delete ${sendIds.length} filtered record(s)? This cannot be undone.`
      : `Delete ALL ${sendIds.length} history record(s)? This cannot be undone.`

    if (!confirm(confirmMsg)) return

    const CHUNK = POSTGREST_IN_CHUNK

    // Fetch attachment storage_paths BEFORE deleting the rows (chunked).
    const pathsToRemove: string[] = []
    for (let i = 0; i < sendIds.length; i += CHUNK) {
      const chunk = sendIds.slice(i, i + CHUNK)
      const { data: attRows } = await supabase
        .from('send_attachments')
        .select('storage_path')
        .in('send_id', chunk)
      if (attRows) pathsToRemove.push(...attRows.map(r => r.storage_path).filter(Boolean))
    }

    // Delete rows in chunks. If any chunk fails, stop and surface the error.
    let firstError: { stage: string, err: { message: string } } | null = null
    for (let i = 0; i < sendIds.length && !firstError; i += CHUNK) {
      const chunk = sendIds.slice(i, i + CHUNK)

      const ev = await supabase.from('email_events').delete().in('send_id', chunk)
      if (ev.error && !firstError) firstError = { stage: 'events', err: ev.error }

      const at = await supabase.from('send_attachments').delete().in('send_id', chunk)
      if (at.error && !firstError) firstError = { stage: 'attachments', err: at.error }

      const se = await supabase.from('email_sends').delete().in('id', chunk).eq('tenant_id', tenantId)
      if (se.error && !firstError) firstError = { stage: 'sends', err: se.error }
    }

    if (firstError) {
      alert(`Failed to delete ${firstError.stage}: ${errorMessage(firstError.err)}`)
      return
    }

    // Best-effort storage cleanup (chunked).
    for (let i = 0; i < pathsToRemove.length; i += CHUNK) {
      const chunk = pathsToRemove.slice(i, i + CHUNK)
      const { error: storageErr } = await supabase.storage.from(BUCKET_NAME).remove(chunk)
      if (storageErr) console.error('Storage cleanup failed (rows already deleted):', storageErr)
    }

    // After delete, re-fetch the current page (or page 1 if we deleted
    // everything on the current page).
    const newTotal = Math.max(0, totalCount - sendIds.length)
    const newPage = Math.min(currentPage, Math.max(1, Math.ceil(newTotal / SENDS_PER_PAGE)))
    setCurrentPage(newPage)
    await fetchPage(newPage, tenantId, { silent: false })
  }

  return (
    <div className="bg-white p-6 rounded shadow">
      <div className="flex flex-wrap gap-4 mb-4 items-center">
        <h2 className="text-lg font-bold mr-auto">Sent Emails</h2>
        <input
          type="text"
          placeholder="Search email or subject..."
          value={searchEmail}
          onChange={e => { setSearchEmail(e.target.value); setCurrentPage(1) }}
          className="border p-2 rounded text-sm w-48"
        />
        <input
          type="text"
          placeholder="Search file name..."
          value={searchFile}
          onChange={e => { setSearchFile(e.target.value); setCurrentPage(1) }}
          className="border p-2 rounded text-sm w-40"
        />
        <input
          type="date"
          value={dateFrom}
          onChange={e => { setDateFrom(e.target.value); setCurrentPage(1) }}
          className="border p-2 rounded text-sm"
        />
        <span className="text-gray-500">to</span>
        <input
          type="date"
          value={dateTo}
          onChange={e => { setDateTo(e.target.value); setCurrentPage(1) }}
          className="border p-2 rounded text-sm"
        />
        {hasFilters && (
          <button onClick={clearFilters} className="text-red-600 hover:underline text-sm px-2">
            Clear Filters
          </button>
        )}
        <button
          onClick={downloadCSV}
          disabled={exporting}
          title={hasFilters
            ? 'Export every record matching the current filters'
            : 'Export the entire history (no filters active)'}
          className="bg-green-600 text-white px-4 py-2 rounded text-sm hover:bg-green-700 disabled:opacity-60"
        >
          {exporting
            ? 'Preparing CSV...'
            : hasFilters
            ? 'Download Filtered CSV'
            : 'Download All CSV'}
        </button>
        <button onClick={deleteRecords} className="bg-red-600 text-white px-4 py-2 rounded text-sm hover:bg-red-700">
          {hasFilters ? `Delete Filtered` : 'Delete All'}
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <svg className="animate-spin h-5 w-5 mr-3 text-blue-500" fill="none" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
            <path fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          Loading history...
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {visibleFilteredSends.map(s => {
            const atts = attachments[s.id] || []
            const evtList = events[s.id] || []
            const isExpanded = expandedId === s.id
            return (
            <div key={s.id} className="border rounded">
              <div onClick={() => toggleExpand(s.id)} className="p-3 cursor-pointer hover:bg-gray-50 flex items-center justify-between">
                <div className="flex-1 grid grid-cols-7 gap-2 text-sm">
                  <div className="text-gray-500 text-xs">
                    {s.send_at
                      ? formatIST(s.send_at)
                      : s.status === 'scheduled'
                      ? <span className="text-blue-600">Sch: {formatIST(s.send_at || s.created_at)}</span>
                      : formatIST(s.created_at)}
                  </div>
                  <div className="truncate">{s.recipient_email}</div>
                  <div className="truncate">{s.subject}</div>
                  <div className="truncate text-xs text-gray-500">{atts.map(a => a.file_name).join(', ') || '-'}</div>
                  <div>
                    <span className={`px-2 py-1 rounded-full text-xs ${
                      s.status === 'sent' ? 'bg-green-100 text-green-800' :
                      s.status === 'failed' ? 'bg-red-100 text-red-800' :
                      s.status === 'scheduled' ? 'bg-blue-100 text-blue-800' : 'bg-yellow-100 text-yellow-800'
                    }`}>
                      {s.status}
                    </span>
                  </div>
                  <div>
                    <span className={`px-2 py-1 rounded text-xs ${s.open_count > 0 ? 'bg-blue-100 text-blue-800 font-bold' : 'bg-gray-100 text-gray-500'}`}>
                      👁 {s.open_count || 0}
                    </span>
                  </div>
                  <div>
                    <span className={`px-2 py-1 rounded text-xs ${s.click_count > 0 ? 'bg-purple-100 text-purple-800 font-bold' : 'bg-gray-100 text-gray-500'}`}>
                      🔗 {s.click_count || 0}
                    </span>
                  </div>
                </div>
                <div className="ml-2 text-gray-400">{isExpanded ? '▲' : '▼'}</div>
              </div>
              {isExpanded && (
                <div className="p-3 bg-gray-50 border-t text-sm">
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <span className="font-medium">📎 Attachments:</span>
                      {atts.length > 0 ? (
                        <div className="flex flex-wrap gap-2 mt-1">
                          {atts.map(a => (
                            <span key={a.id} className="text-xs bg-white px-2 py-1 rounded border text-gray-600">
                              {a.file_name}
                            </span>
                          ))}
                        </div>
                      ) : <span className="text-gray-400 ml-2">None</span>}
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteSingleRecord(s.id) }}
                      className="text-red-600 hover:text-red-800 text-xs px-2 py-1 border border-red-300 rounded hover:bg-red-50 ml-4 shrink-0"
                    >
                      Delete Record
                    </button>
                  </div>
                  <div>
                    <span className="font-medium">📊 Activity Timeline:</span>
                    {evtList.length > 0 ? (
                      <div className="mt-2 space-y-1 max-h-60 overflow-y-auto border rounded bg-white p-2">
                        {evtList.map((e, i) => {
                          let hostname = ''
                          let href: string | null = null
                          if (e.clicked_url) {
                            try {
                              const u = new URL(e.clicked_url)
                              hostname = u.hostname
                              href = u.href
                            } catch {
                              hostname = e.clicked_url
                              href = null
                            }
                          }
                          return (
                            <div key={i} className={`flex items-center gap-2 text-xs ${e.event_type === 'open' ? 'text-blue-600' : 'text-purple-600'}`}>
                              <span className="shrink-0">{e.event_type === 'open' ? '👁 Opened' : '🔗 Clicked'}</span>
                              {e.clicked_url && (
                                href ? (
                                  <a
                                    href={href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(ev) => ev.stopPropagation()}
                                    className="text-blue-600 hover:underline truncate max-w-xs"
                                    title={e.clicked_url}
                                  >
                                    {hostname}
                                  </a>
                                ) : (
                                  <span className="text-blue-600 truncate max-w-xs" title={e.clicked_url}>
                                    {hostname}
                                  </span>
                                )
                              )}
                              <span className="text-gray-400 shrink-0 ml-auto">• {formatIST(e.created_at)}</span>
                            </div>
                          )
                        })}
                      </div>
                    ) : <span className="text-gray-400 ml-2">No opens or clicks recorded yet</span>}
                  </div>
                </div>
              )}
            </div>
          )})}
          {visibleFilteredSends.length === 0 && (
            <p className="text-center text-gray-400 py-4">
              {hasFilters ? 'No records match your filters on this page. Try clearing filters or going to the next page.' : 'No emails sent yet'}
            </p>
          )}
        </div>
        {totalPages >= 1 && (
          <div className="flex justify-between items-center mt-4 pt-3 border-t">
            <span className="text-sm text-gray-500">
              Showing {showingFrom}-{showingTo} of {totalSends}
            </span>
            <div className="flex items-center gap-2">
              <button onClick={handlePrevPage} disabled={currentPage === 1} className="px-3 py-1 text-sm border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50">← Previous</button>
              <span className="text-sm">Page {currentPage} of {totalPages}</span>
              <button onClick={handleNextPage} disabled={currentPage === totalPages || totalPages === 0} className="px-3 py-1 text-sm border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50">Next →</button>
            </div>
          </div>
        )}
        </>
      )}
    </div>
  )
}


interface StorageFile {
  name: string
  id: string | null
  updated_at: string
  size: number
  metadata: Record<string, unknown>
}

function FilesTab({ session }: { session: Session }) {
  const [files, setFiles] = useState<StorageFile[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [exactMatch, setExactMatch] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [tenantId, setTenantId] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const FILES_PER_PAGE = 12

  const BUCKET_NAME = 'dfsdfsdf'

  useEffect(() => {
    const fetchTenantId = async () => {
      const { data: membership } = await supabase.from('memberships').select('tenant_id').eq('user_id', session.user.id).single()
      if (membership) setTenantId(membership.tenant_id)
    }
    fetchTenantId()
  }, [session.user.id])

  const fetchFiles = async () => {
    if (!tenantId) return
    setLoading(true)
    // Paginated storage list -- the prior `{ limit: 100 }` silently
    // truncated to 100 files per folder. Tenants with >100 uploaded
    // attachments would see only the first 100 in the Files tab.
    try {
      const allFiles = await listAllStorageFiles(BUCKET_NAME, tenantId)
      setFiles(allFiles.map(f => ({
        name: f.name,
        id: f.id,
        updated_at: f.updated_at || '',
        size: (f.metadata?.size as number) || 0,
        metadata: f.metadata || {}
      })))
    } catch (err) {
      console.error('Error fetching files:', err)
    }
    setLoading(false)
  }

  useEffect(() => {
    if (tenantId) fetchFiles()
  }, [tenantId])

  const handleUpload = async () => {
    if (!selectedFile || !tenantId) return
    setUploading(true)
    try {
      const ext = selectedFile.name.split('.').pop()
      const baseName = selectedFile.name.replace(`.${ext}`, '')
      const timestamp = Date.now()
      const uniquePath = `${tenantId}/${timestamp}-${baseName}.${ext}`
      
      const { error } = await supabase.storage.from(BUCKET_NAME).upload(uniquePath, selectedFile, {
        cacheControl: '3600',
        upsert: false
      })
      
      if (error) throw error
      setSelectedFile(null)
      fetchFiles()
    } catch (err) {
      alert(`Upload failed: ${errorMessage(err)}`)
    }
    setUploading(false)
  }

  const handleDelete = async (path: string) => {
    if (!confirm('Delete this file? This will also remove any attachment references in send history.')) return
    const { error } = await supabase.storage.from(BUCKET_NAME).remove([path])
    if (error) {
      alert(`Delete failed: ${errorMessage(error)}`)
      return
    }
    // Cascade: delete send_attachments rows that reference this storage path,
    // so we don't leave dangling metadata pointing at a deleted file.
    const { error: attErr } = await supabase
      .from('send_attachments')
      .delete()
      .eq('storage_path', path)
    if (attErr) console.error('Failed to cascade-delete send_attachments:', attErr)
    fetchFiles()
  }

  const getPublicUrl = (path: string) => {
    const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(path)
    return data.publicUrl
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }

  const filteredFiles = files.filter(f =>
    search === '' || (exactMatch ? f.name.toLowerCase() === search.toLowerCase() : f.name.toLowerCase().includes(search.toLowerCase()))
  )

  const totalFiles = filteredFiles.length
  const totalPages = Math.ceil(totalFiles / FILES_PER_PAGE)
  const showingFrom = totalFiles === 0 ? 0 : (currentPage - 1) * FILES_PER_PAGE + 1
  const showingTo = Math.min(currentPage * FILES_PER_PAGE, totalFiles)
  const paginatedFiles = filteredFiles.slice((currentPage - 1) * FILES_PER_PAGE, currentPage * FILES_PER_PAGE)

  const handlePrevPage = () => {
    if (currentPage > 1) setCurrentPage(currentPage - 1)
  }

  const handleNextPage = () => {
    if (currentPage < totalPages) setCurrentPage(currentPage + 1)
  }

  const hasFilters = search

  const deleteFilteredFiles = async () => {
    const filesToDelete = hasFilters ? filteredFiles : files
    if (filesToDelete.length === 0 || !tenantId) return

    const confirmMsg = hasFilters
      ? `Delete ${filesToDelete.length} filtered files? This will also remove any attachment references in send history. This cannot be undone.`
      : `Delete ALL ${filesToDelete.length} files? This will also remove any attachment references in send history. This cannot be undone.`

    if (!confirm(confirmMsg)) return

    const pathsToDelete = filesToDelete.map(f => `${tenantId}/${f.name}`)

    // Storage .remove() takes a body, so no URL length issue on the
    // storage call itself. But chunk anyway -- 1000 files in one HTTP
    // POST body is heavy and some Supabase gateway tiers cap body size.
    const STORAGE_REMOVE_CHUNK = 500
    for (const chunk of chunkArray(pathsToDelete, STORAGE_REMOVE_CHUNK)) {
      const { error } = await supabase.storage.from(BUCKET_NAME).remove(chunk)
      if (error) {
        alert(`Delete failed: ${errorMessage(error)}`)
        return
      }
    }

    // Cascade: delete send_attachments rows that referenced any of these
    // storage paths, so we don't leave dangling metadata.
    // Chunk .in() -- storage paths are long strings, so the URL limit
    // bites at ~80-100 paths. Chunking to 100 keeps us safely under.
    const STORAGE_PATH_IN_CHUNK = 100
    for (const chunk of chunkArray(pathsToDelete, STORAGE_PATH_IN_CHUNK)) {
      const { error: attErr } = await supabase
        .from('send_attachments')
        .delete()
        .in('storage_path', chunk)
      if (attErr) console.error('Failed to cascade-delete send_attachments:', attErr)
    }
    fetchFiles()
  }

  return (
    <div className="bg-white p-6 rounded shadow">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-bold">File Manager</h2>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Search files..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border p-2 rounded text-sm w-48"
          />
          <input
            id="exactMatchFile"
            type="checkbox"
            checked={exactMatch}
            onChange={(e) => setExactMatch(e.target.checked)}
          />
          <label htmlFor="exactMatchFile" className="text-sm">Exact</label>
          {files.length > 0 && (
            <button onClick={deleteFilteredFiles} className="bg-red-600 text-white px-3 py-2 rounded text-sm hover:bg-red-700">
              {hasFilters ? `Delete (${filteredFiles.length})` : `Delete All (${files.length})`}
            </button>
          )}
          <input
            type="file"
            onChange={(e) => e.target.files?.[0] && setSelectedFile(e.target.files[0])}
            className="text-sm"
          />
          <button
            onClick={handleUpload}
            disabled={!selectedFile || uploading}
            className="bg-blue-600 text-white px-4 py-2 rounded text-sm disabled:opacity-50"
          >
            {uploading ? 'Uploading...' : 'Upload'}
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-center py-4">Loading...</p>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {paginatedFiles.map((file) => {
            const fullPath = `${tenantId}/${file.name}`
            return (
              <div key={file.id} className="border rounded p-4 hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate" title={file.name}>
                      {file.name}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {formatSize(file.size)} • {file.updated_at ? new Date(file.updated_at).toLocaleDateString() : 'Unknown date'}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 mt-3">
                  <a
                    href={getPublicUrl(fullPath)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline text-xs"
                  >
                    View
                  </a>
                  <button
                    onClick={() => navigator.clipboard.writeText(getPublicUrl(fullPath))}
                    className="text-gray-600 hover:text-black text-xs"
                  >
                    Copy URL
                  </button>
                  <button
                    onClick={() => handleDelete(fullPath)}
                    className="text-red-600 hover:text-red-800 text-xs"
                  >
                    Delete
                  </button>
                </div>
              </div>
            )
          })}
          {paginatedFiles.length === 0 && filteredFiles.length > 0 && (
            <p className="col-span-full text-center text-gray-400 py-8">
              No files on this page
            </p>
          )}
          {filteredFiles.length === 0 && (
            <p className="col-span-full text-center text-gray-400 py-8">
              {search ? 'No files match your search' : 'No files uploaded yet'}
            </p>
          )}
        </div>
        {totalPages >= 1 && (
          <div className="flex justify-between items-center mt-4 pt-3 border-t">
            <span className="text-sm text-gray-500">Showing {showingFrom}-{showingTo} of {totalFiles}</span>
            <div className="flex items-center gap-2">
              <button onClick={handlePrevPage} disabled={currentPage === 1} className="px-3 py-1 text-sm border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50">← Previous</button>
              <span className="text-sm">Page {currentPage} of {totalPages}</span>
              <button onClick={handleNextPage} disabled={currentPage === totalPages || totalPages === 0} className="px-3 py-1 text-sm border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50">Next →</button>
            </div>
          </div>
        )}
        </>
      )}
    </div>
  )
}

interface ListWithCount {
  id: string
  name: string
  created_at: string
  subscriber_count: number
}

function ListsTab({ session, onSelectList, onListsChanged }: { session: Session, onSelectList: (listId: string | null) => void, onListsChanged?: () => void }) {
  const [lists, setLists] = useState<ListWithCount[]>([])
  const [loading, setLoading] = useState(true)
  const [newListName, setNewListName] = useState('')
  const [showAddForm, setShowAddForm] = useState(false)
  const [search, setSearch] = useState('')
  const [exactMatch, setExactMatch] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const LISTS_PER_PAGE = 10

  const fetchLists = async () => {
    setLoading(true)
    const { data: membership } = await supabase.from('memberships').select('tenant_id').eq('user_id', session.user.id).single()
    if (!membership) { setLoading(false); return }

    // Paginated + errors surfaced -- the prior bare .select('*') capped at
    // the PostgREST 1000-row limit silently and discarded query errors.
    let listData: { id: string, name: string, created_at: string }[]
    try {
      listData = await fetchAllPaginated<{ id: string, name: string, created_at: string }>(
        supabase
          .from('lists')
          .select('id, name, created_at')
          .eq('tenant_id', membership.tenant_id)
          .order('name')
      )
    } catch (err) {
      console.error('Failed to load lists:', err)
      alert(`Failed to load lists: ${errorMessage(err)}`)
      setLoading(false)
      return
    }

    if (listData) {
      // Count contacts per list WITHOUT firing one COUNT query per list.
      // The previous implementation did Promise.all(listData.map(list =>
      // supabase.from('contacts').select('*', { count: 'exact', head: true
      // }).eq('list_id', list.id))) which was an N+1 query pattern: 50 lists
      // = 50 parallel round-trips, 500 lists = 500 parallel round-trips.
      //
      // Instead we fetch only the list_id column for every contact (small
      // payload — just UUIDs) and count client-side. With 10k contacts this
      // is one or two paginated round-trips instead of 10k/N list-count
      // queries, and it stays cheap regardless of how many lists exist.
      const countByListId: Record<string, number> = {}
      try {
        const allContactListIds = await fetchAllPaginated<{ list_id: string | null }>(
          supabase
            .from('contacts')
            .select('list_id')
            .eq('tenant_id', membership.tenant_id)
            .not('list_id', 'is', null)
        )
        allContactListIds.forEach(c => {
          if (c.list_id) {
            countByListId[c.list_id] = (countByListId[c.list_id] || 0) + 1
          }
        })
      } catch (err) {
        console.error('Failed to fetch contact counts per list:', err)
      }

      const listsWithCounts = listData.map(list => ({
        ...list,
        subscriber_count: countByListId[list.id] || 0
      }))
      setLists(listsWithCounts)
    }
    setLoading(false)
  }

  useEffect(() => {
    fetchLists()
  }, [])

  const handleAddList = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newListName.trim()) return

    const { data: membership } = await supabase.from('memberships').select('tenant_id').eq('user_id', session.user.id).single()
    if (!membership) return

    const { error: insertErr } = await supabase.from('lists').insert({ tenant_id: membership.tenant_id, name: newListName.trim() })
    if (insertErr) {
      alert(`Failed to create list: ${errorMessage(insertErr)}`)
      return
    }
    setNewListName('')
    setShowAddForm(false)
    fetchLists()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this list? Contacts will be unlinked but not deleted.')) return
    const { error } = await supabase.from('lists').delete().eq('id', id)
    if (error) {
      alert(`Failed to delete list: ${errorMessage(error)}`)
      return
    }
    fetchLists()
  }

  const startEdit = (list: ListWithCount) => {
    setEditingId(list.id)
    setEditName(list.name)
  }

  const saveEdit = async () => {
    if (!editingId || !editName.trim()) return
    const { error } = await supabase.from('lists').update({ name: editName.trim() }).eq('id', editingId)
    if (error) {
      alert(`Failed to rename list: ${errorMessage(error)}`)
      return
    }
    setEditingId(null)
    setEditName('')
    onListsChanged?.()
    fetchLists()
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditName('')
  }

  const filteredLists = lists.filter(l =>
    !search || (exactMatch ? l.name.toLowerCase() === search.toLowerCase() : l.name.toLowerCase().includes(search.toLowerCase()))
  )

  const totalLists = filteredLists.length
  const totalPages = Math.ceil(totalLists / LISTS_PER_PAGE)
  const showingFrom = totalLists === 0 ? 0 : (currentPage - 1) * LISTS_PER_PAGE + 1
  const showingTo = Math.min(currentPage * LISTS_PER_PAGE, totalLists)
  const paginatedLists = filteredLists.slice((currentPage - 1) * LISTS_PER_PAGE, currentPage * LISTS_PER_PAGE)

  const handlePrevPage = () => {
    if (currentPage > 1) setCurrentPage(currentPage - 1)
  }

  const handleNextPage = () => {
    if (currentPage < totalPages) setCurrentPage(currentPage + 1)
  }

  const hasFilters = search

  const deleteFilteredLists = async () => {
    const dataToDelete = hasFilters ? filteredLists : lists
    if (dataToDelete.length === 0) return

    const confirmMsg = hasFilters
      ? `Delete ${dataToDelete.length} filtered lists? Contacts will be unlinked but not deleted.`
      : `Delete ALL ${dataToDelete.length} lists? Contacts will be unlinked but not deleted.`

    if (!confirm(confirmMsg)) return

    const listIds = dataToDelete.map(l => l.id)
    // Chunked .in() -- replaces the prior one-list-at-a-time loop.
    // Errors are surfaced: a silent partial delete here would leave the
    // user believing every list was removed.
    let firstError: string | null = null
    for (const chunk of chunkArray(listIds, POSTGREST_IN_CHUNK)) {
      const { error } = await supabase.from('lists').delete().in('id', chunk)
      if (error && !firstError) firstError = errorMessage(error)
    }
    if (firstError) {
      alert(`Some lists failed to delete: ${firstError}. Refresh to see remaining.`)
    }
    fetchLists()
  }

  return (
    <div className="bg-white p-6 rounded shadow">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold">Lists</h2>
        <div className="flex gap-2 items-center">
          <input
            type="text"
            placeholder="Search lists..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="border p-2 rounded text-sm w-40"
          />
          <input
            id="exactMatchList"
            type="checkbox"
            checked={exactMatch}
            onChange={e => setExactMatch(e.target.checked)}
          />
          <label htmlFor="exactMatchList" className="text-sm">Exact</label>
          {lists.length > 0 && (
            <button onClick={deleteFilteredLists} className="bg-red-600 text-white px-3 py-2 rounded text-sm hover:bg-red-700">
              {hasFilters ? `Delete (${filteredLists.length})` : `Delete All (${lists.length})`}
            </button>
          )}
          <button 
            onClick={() => setShowAddForm(!showAddForm)} 
            className="text-blue-600 hover:underline text-sm"
          >
            {showAddForm ? 'Cancel' : '+ New List'}
          </button>
        </div>
      </div>

      {showAddForm && (
        <form onSubmit={handleAddList} className="flex gap-2 mb-4 p-3 bg-gray-50 rounded">
          <input
            type="text"
            placeholder="List name"
            value={newListName}
            onChange={e => setNewListName(e.target.value)}
            className="border p-2 rounded flex-1"
            required
          />
          <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded">Create</button>
        </form>
      )}

      {loading ? (
        <p>Loading...</p>
      ) : (
        <>
          <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="text-left p-2">List Name</th>
              <th className="text-left p-2">Subscribers</th>
              <th className="text-left p-2">Created</th>
              <th className="text-left p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {paginatedLists.map(list => (
              <tr key={list.id} className="border-b hover:bg-gray-50">
                <td className="p-2">
                  {editingId === list.id ? (
                    <div className="flex gap-1">
                      <input
                        type="text"
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        className="border p-1 rounded text-sm w-32"
                        autoFocus
                      />
                      <button onClick={saveEdit} className="text-green-600 text-xs">Save</button>
                      <button onClick={cancelEdit} className="text-gray-500 text-xs">Cancel</button>
                    </div>
                  ) : (
                    <span className="font-medium">{list.name}</span>
                  )}
                </td>
                <td className="p-2">
                  <button 
                    onClick={() => onSelectList(list.id)}
                    className="text-blue-600 hover:underline font-bold"
                    title="Click to filter contacts by this list"
                  >
                    {list.subscriber_count}
                  </button>
                </td>
                <td className="p-2 text-gray-500">{new Date(list.created_at).toLocaleDateString()}</td>
                <td className="p-2">
                  {editingId !== list.id && (
                    <>
                      <button onClick={() => startEdit(list)} className="text-blue-600 text-xs hover:underline mr-2">Edit</button>
                      <button onClick={() => handleDelete(list.id)} className="text-red-600 text-xs hover:underline">Delete</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {paginatedLists.length === 0 && filteredLists.length > 0 && (
              <tr><td colSpan={4} className="p-4 text-center text-gray-400">No lists on this page</td></tr>
            )}
            {filteredLists.length === 0 && (
              <tr><td colSpan={4} className="p-4 text-center text-gray-400">{search ? 'No lists match your search' : 'No lists yet'}</td></tr>
            )}
          </tbody>
        </table>
        {totalPages >= 1 && (
          <div className="flex justify-between items-center mt-4 pt-3 border-t">
            <span className="text-sm text-gray-500">Showing {showingFrom}-{showingTo} of {totalLists}</span>
            <div className="flex items-center gap-2">
              <button onClick={handlePrevPage} disabled={currentPage === 1} className="px-3 py-1 text-sm border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50">← Previous</button>
              <span className="text-sm">Page {currentPage} of {totalPages}</span>
              <button onClick={handleNextPage} disabled={currentPage === totalPages || totalPages === 0} className="px-3 py-1 text-sm border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50">Next →</button>
            </div>
          </div>
        )}
        </>
      )}
    </div>
  )
}

type BatchRow = {
  id: string
  subject: string
  status: string
  total_count: number
  sent_count: number
  failed_count: number
  created_at: string
  started_at: string | null
  completed_at: string | null
  list_id: string | null
  scheduled_at: string | null
}

function BatchesTab({ session }: { session: Session }) {
  const [batches, setBatches] = useState<BatchRow[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [recipients, setRecipients] = useState<Record<string, { email: string; status: string; error_detail: string | null }[]>>({})
  const [currentPage, setCurrentPage] = useState(1)
  const [totalCount, setTotalCount] = useState(0)
  const [search, setSearch] = useState('')
  const [exactMatch, setExactMatch] = useState(false)
  const [tenantId, setTenantId] = useState<string | null>(null)
  const BATCHES_PER_PAGE = 10

  const fetchBatches = async (page: number = 1) => {
    setLoading(true)
    const { data: membership } = await supabase.from('memberships').select('tenant_id').eq('user_id', session.user.id).single()
    if (!membership) { setLoading(false); return }
    setTenantId(membership.tenant_id)

    const from = (page - 1) * BATCHES_PER_PAGE
    const to = from + BATCHES_PER_PAGE - 1

    // Slim column list -- the UI uses these 11 fields only. The prior
    // select('*') also pulled `content` (the full email HTML, tens of KB
    // per row) on every load AND every 10-second auto-refresh -- the same
    // heavy-column class that caused the History tab timeouts.
    const BATCH_COLUMNS = 'id, subject, status, total_count, sent_count, failed_count, created_at, started_at, completed_at, list_id, scheduled_at'

    let batchesQuery = supabase.from('batches').select(BATCH_COLUMNS).eq('tenant_id', membership.tenant_id)
    let countQuery = supabase.from('batches').select(BATCH_COLUMNS, { count: 'exact', head: true }).eq('tenant_id', membership.tenant_id)

    if (search) {
      if (exactMatch) {
        batchesQuery = batchesQuery.eq('subject', search)
        countQuery = countQuery.eq('subject', search)
      } else {
        batchesQuery = batchesQuery.ilike('subject', `%${search}%`)
        countQuery = countQuery.ilike('subject', `%${search}%`)
      }
    }

    try {
      const [batchesResult, countResult] = await Promise.all([
        batchesQuery.order('created_at', { ascending: false }).range(from, to),
        countQuery
      ])
      // Errors surfaced -- the prior code discarded query errors entirely,
      // so a failed load silently showed an empty/stale list.
      if (batchesResult.error) throw batchesResult.error
      if (batchesResult.data) setBatches(batchesResult.data as BatchRow[])
      if (countResult.count !== null) setTotalCount(countResult.count)
      setCurrentPage(page)
    } catch (err) {
      console.error('Failed to load batches:', err)
      alert(`Failed to load batches: ${errorMessage(err)}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchBatches(1) }, [session.user.id])

  useEffect(() => {
    const interval = setInterval(() => fetchBatches(currentPage), 10000)
    return () => clearInterval(interval)
  }, [session.user.id, currentPage])

  const handlePrevPage = () => {
    if (currentPage > 1) fetchBatches(currentPage - 1)
  }

  const handleNextPage = () => {
    if (currentPage * BATCHES_PER_PAGE < totalCount) fetchBatches(currentPage + 1)
  }

  const hasFilters = search

  const deleteFilteredBatches = async () => {
    if (!tenantId) return

    // Fetch ALL matching batch IDs (paginated) -- without this, only
    // the first 1000 batches would be deleted even when the user
    // confirms 'Delete All'.
    let deleteQuery = supabase.from('batches').select('id').eq('tenant_id', tenantId)
    if (search) {
      if (exactMatch) {
        deleteQuery = deleteQuery.eq('subject', search)
      } else {
        deleteQuery = deleteQuery.ilike('subject', `%${search}%`)
      }
    }

    let batchesToDelete: { id: string }[] = []
    try {
      batchesToDelete = await fetchAllPaginated<{ id: string }>(deleteQuery)
    } catch (err) {
      alert(`Failed to list batches for deletion: ${errorMessage(err)}`)
      return
    }
    if (batchesToDelete.length === 0) return

    const confirmMsg = hasFilters
      ? `Delete ${batchesToDelete.length} filtered batches? This cannot be undone.`
      : `Delete ALL ${batchesToDelete.length} batches? This cannot be undone.`

    if (!confirm(confirmMsg)) return

    const batchIds = batchesToDelete.map(b => b.id)

    // Chunked recipient_list delete -- .in() would blow URL length past
    // ~300 UUIDs. Replaces the previous one-batch-at-a-time loop
    // (was O(n) round-trips; now ~n/200 round-trips).
    // Abort before touching the batches rows if this fails -- otherwise
    // the batches would vanish while their recipients remain (orphans).
    let firstRlError: string | null = null
    for (const chunk of chunkArray(batchIds, POSTGREST_IN_CHUNK)) {
      const { error: rlErr } = await supabase.from('recipient_list').delete().in('batch_id', chunk)
      if (rlErr && !firstRlError) firstRlError = errorMessage(rlErr)
    }
    if (firstRlError) {
      alert(`Failed to delete recipient lists: ${firstRlError}. No batches were deleted.`)
      return
    }

    // Chunked batches delete -- same reason.
    let firstError: string | null = null
    for (const chunk of chunkArray(batchIds, POSTGREST_IN_CHUNK)) {
      const { error } = await supabase.from('batches').delete().in('id', chunk).eq('tenant_id', tenantId)
      if (error && !firstError) firstError = errorMessage(error)
    }
    if (firstError) {
      alert(`Some batches failed to delete: ${firstError}. Refresh to see remaining.`)
      return
    }
    fetchBatches(1)
  }

  const deleteSingleBatch = async (batchId: string, subject: string) => {
    if (!tenantId) return
    const sentCount = (batches.find(b => b.id === batchId)?.sent_count || 0)
    const confirmMsg = sentCount > 0
      ? `Delete batch "${subject}"?\n\n${sentCount} email(s) have already been sent. This only removes the batch record and recipient list; it does NOT recall sent emails.\n\nThis cannot be undone.`
      : `Delete batch "${subject}"? This cannot be undone.`
    if (!confirm(confirmMsg)) return

    const { error: rlError } = await supabase.from('recipient_list').delete().eq('batch_id', batchId)
    if (rlError) {
      alert(`Failed to delete batch recipients: ${errorMessage(rlError)}. The batch was NOT deleted.`)
      return
    }
    const { error } = await supabase.from('batches').delete().eq('id', batchId).eq('tenant_id', tenantId)
    if (error) {
      console.error('Failed to delete batch:', error)
      alert(`Failed to delete batch: ${errorMessage(error)}`)
      return
    }
    // Collapse expanded view if it was open
    if (expandedId === batchId) {
      setExpandedId(null)
      setRecipients(prev => {
        const { [batchId]: _removed, ...rest } = prev
        return rest
      })
    }
    fetchBatches(currentPage)
  }

  const fetchRecipients = async (batchId: string) => {
    if (recipients[batchId]) {
      setExpandedId(expandedId === batchId ? null : batchId)
      return
    }
    // Paginated -- batches with >1000 recipients (e.g. 3000-mail sends)
    // would otherwise have their recipient list silently truncated.
    try {
      const all = await fetchAllPaginated<{ email: string; status: string; error_detail: string | null }>(
        supabase.from('recipient_list').select('email, status, error_detail').eq('batch_id', batchId).order('created_at')
      )
      setRecipients(prev => ({ ...prev, [batchId]: all }))
      setExpandedId(batchId)
    } catch (err) {
      console.error('Failed to load recipients:', err)
    }
  }

  const statusColor = (status: string) => {
    switch (status) {
      case 'pending': return 'bg-yellow-100 text-yellow-800'
      case 'processing': return 'bg-blue-100 text-blue-800'
      case 'completed': return 'bg-green-100 text-green-800'
      case 'failed': return 'bg-red-100 text-red-800'
      case 'paused': return 'bg-gray-100 text-gray-800'
      default: return 'bg-gray-100 text-gray-800'
    }
  }

  const totalPages = Math.ceil(totalCount / BATCHES_PER_PAGE)
  const showingFrom = totalCount === 0 ? 0 : (currentPage - 1) * BATCHES_PER_PAGE + 1
  const showingTo = Math.min(currentPage * BATCHES_PER_PAGE, totalCount)

  return (
    <div className="bg-white p-6 rounded shadow">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-bold">Batch Sends</h2>
        <button onClick={() => fetchBatches(currentPage)} className="text-sm text-blue-600 hover:underline">Refresh</button>
      </div>
      <div className="flex gap-2 mb-4 items-center">
        <input
          type="text"
          placeholder="Search by subject..."
          value={search}
          onChange={e => { setSearch(e.target.value); setCurrentPage(1); fetchBatches(1) }}
          className="border p-2 rounded text-sm w-48"
        />
        <input
          id="exactMatchBatch"
          type="checkbox"
          checked={exactMatch}
          onChange={e => { setExactMatch(e.target.checked); setCurrentPage(1); fetchBatches(1) }}
        />
        <label htmlFor="exactMatchBatch" className="text-sm">Exact</label>
        {search && (
          <button onClick={() => { setSearch(''); setCurrentPage(1); fetchBatches(1) }} className="text-red-600 hover:underline text-sm">Clear</button>
        )}
        {totalCount > 0 && (
          <button onClick={deleteFilteredBatches} className="bg-red-600 text-white px-3 py-2 rounded text-sm hover:bg-red-700">
            {hasFilters ? `Delete (${totalCount})` : `Delete All (${totalCount})`}
          </button>
        )}
      </div>
      {loading ? <p>Loading...</p> : batches.length === 0 ? <p className="text-gray-500">{search ? 'No batches match your search' : 'No batch sends yet. Use "Send to List" in Compose to create one.'}</p> : (
        <>
          <div className="space-y-3">
          {batches.map(batch => {
            const sent = batch.sent_count || 0
            const failed = batch.failed_count || 0
            const total = batch.total_count || 0
            const progress = total > 0 ? Math.round((sent + failed) / total * 100) : 0
            return (
              <div key={batch.id} className="border rounded p-3">
                <div className="flex justify-between items-center cursor-pointer" onClick={() => fetchRecipients(batch.id)}>
                  <div>
                    <div className="font-medium">{batch.subject}</div>
                    <div className="text-xs text-gray-500">
                      Created: {new Date(batch.created_at).toLocaleString()}
                      {batch.scheduled_at && batch.status === 'scheduled' && (
                        <span className="ml-2 text-blue-600">• Scheduled: {new Date(batch.scheduled_at).toLocaleString()}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${statusColor(batch.status)}`}>{batch.status}</span>
                    <span className="text-sm">{total > 0 ? `${sent}/${total} sent` : `${sent} sent`}</span>
                    {progress < 100 && total > 0 && <span className="text-xs text-gray-400">{progress}%</span>}
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteSingleBatch(batch.id, batch.subject) }}
                      className="ml-2 px-2 py-1 text-xs text-red-600 border border-red-300 rounded hover:bg-red-50"
                      title="Delete this batch (does not recall already-sent emails)"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {batch.total_count > 0 && (
                  <div className="mt-2 w-full bg-gray-200 rounded-full h-2">
                    <div className="bg-green-500 h-2 rounded-full" style={{ width: `${Math.round((batch.sent_count || 0) / batch.total_count * 100)}%` }}></div>
                    {(batch.failed_count || 0) > 0 && <div className="bg-red-400 h-2 rounded-full -mt-2" style={{ width: `${Math.round((batch.failed_count || 0) / batch.total_count * 100)}%`, marginLeft: `${Math.round((batch.sent_count || 0) / batch.total_count * 100)}%` }}></div>}
                  </div>
                )}
                {expandedId === batch.id && recipients[batch.id] && (
                  <div className="mt-3 border-t pt-2">
                    <table className="w-full text-xs">
                      <thead><tr className="text-left text-gray-500"><th>Email</th><th>Status</th><th>Error</th></tr></thead>
                      <tbody>
                        {recipients[batch.id].slice(0, 20).map((r, i) => (
                          <tr key={i} className="border-b border-gray-100">
                            <td>{r.email}</td>
                            <td><span className={`px-1 rounded text-xs ${r.status === 'sent' ? 'bg-green-50 text-green-700' : r.status === 'failed' ? 'bg-red-50 text-red-700' : r.status === 'skipped' ? 'bg-gray-50 text-gray-700' : 'bg-yellow-50 text-yellow-700'}`}>{r.status}</span></td>
                            <td className="text-red-500 max-w-xs truncate">{r.error_detail || ''}</td>
                          </tr>
                        ))}
                        {recipients[batch.id].length > 20 && <tr><td colSpan={3} className="text-gray-400 py-1">...and {recipients[batch.id].length - 20} more</td></tr>}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <div className="flex justify-between items-center mt-4 pt-3 border-t">
          <span className="text-sm text-gray-500">Showing {showingFrom}-{showingTo} of {totalCount}</span>
          <div className="flex items-center gap-2">
            <button onClick={handlePrevPage} disabled={currentPage === 1} className="px-3 py-1 text-sm border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50">← Previous</button>
            <span className="text-sm">Page {currentPage} of {totalPages}</span>
            <button onClick={handleNextPage} disabled={currentPage === totalPages || totalPages === 0} className="px-3 py-1 text-sm border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50">Next →</button>
          </div>
        </div>
        </>
      )}
    </div>
  )
}

function SettingsTab({ session }: { session: Session }) {
  const [accessToken, setAccessToken] = useState('')
  const [tokenStatus, setTokenStatus] = useState<{ has_token: boolean, status: string, retry_after: string | null, send_count: number, expires_at: string | null, has_refresh_token: boolean } | null>(null)
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)
  const [oauthLoading, setOauthLoading] = useState(false)

  // Azure AD config state (admin only)
  const [azureConfig, setAzureConfig] = useState<{
    ms_client_id: string | null,
    ms_client_secret_set: boolean,
    ms_client_secret_masked: string | null,
    ms_tenant_id: string | null,
    has_config: boolean,
    config_source: string,
    is_admin: boolean,
    has_env_fallback: boolean
  } | null>(null)
  const [azureForm, setAzureForm] = useState({ ms_client_id: '', ms_client_secret: '', ms_tenant_id: '' })
  const [azureSaving, setAzureSaving] = useState(false)
  const [azureStatus, setAzureStatus] = useState('')
  const [userRole, setUserRole] = useState<string | null>(null)
  const [showSetupGuide, setShowSetupGuide] = useState(false)

  const fetchTokenStatus = async () => {
    try {
      const res = await fetch(MANAGE_TOKEN_URL, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${session.access_token}`, 'apikey': supabaseAnonKey }
      })
      if (res.ok) {
        const data = await res.json()
        setTokenStatus(data)
      }
    } catch (err) {
      console.error('Failed to fetch token status:', err)
    }
  }

  const fetchAzureConfig = async () => {
    try {
      const res = await fetch(AZURE_CONFIG_URL, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${session.access_token}`, 'apikey': supabaseAnonKey }
      })
      if (res.ok) {
        const data = await res.json()
        setAzureConfig(data)
        if (data.ms_client_id) setAzureForm(prev => ({ ...prev, ms_client_id: data.ms_client_id }))
        if (data.ms_tenant_id) setAzureForm(prev => ({ ...prev, ms_tenant_id: data.ms_tenant_id }))
        // Auto-open setup guide if Azure AD is not configured at all
        if (!data.has_config && !data.has_env_fallback) {
          setShowSetupGuide(true)
        }
      }
    } catch (err) {
      console.error('Failed to fetch Azure config:', err)
    }
  }

  useEffect(() => {
    const fetchRole = async () => {
      const { data } = await supabase
        .from('memberships')
        .select('role')
        .eq('user_id', session.user.id)
        .single()
      if (data) setUserRole(data.role)
    }
    fetchRole()
    fetchTokenStatus()
    fetchAzureConfig()
    const params = new URLSearchParams(window.location.search)
    if (params.get('auth_success') === 'true') {
      setStatus('Microsoft account connected successfully!')
      window.history.replaceState({}, '', window.location.pathname)
      fetchTokenStatus()
    }
    if (params.get('auth_error')) {
      setStatus(`OAuth Error: ${params.get('auth_error')}`)
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [session?.user?.id])

  const startOAuthFlow = async () => {
    setOauthLoading(true)
    setStatus('Connecting to Microsoft...')
    try {
      const res = await fetch(`${MS_AUTH_URL}/authorize`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${session.access_token}`, 'apikey': supabaseAnonKey }
      })
      const data = await res.json()
      if (!res.ok) {
        setStatus(`Error: ${data.error || 'Failed to start OAuth flow'}`)
        setOauthLoading(false)
        return
      }
      if (data.authorization_url) {
        window.location.href = data.authorization_url
      }
    } catch (err) {
      setStatus(`Error: ${errorMessage(err)}`)
    }
    setOauthLoading(false)
  }

  const saveAzureConfig = async (e: React.FormEvent) => {
    e.preventDefault()
    setAzureSaving(true)
    setAzureStatus('Saving...')
    try {
      const res = await fetch(AZURE_CONFIG_URL, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': supabaseAnonKey
        },
        body: JSON.stringify({
          ms_client_id: azureForm.ms_client_id.trim(),
          ms_client_secret: azureForm.ms_client_secret.trim(),
          ms_tenant_id: azureForm.ms_tenant_id.trim(),
        })
      })
      const data = await res.json()
      if (!res.ok) {
        setAzureStatus(`Error: ${data.error || 'Failed to save'}`)
      } else {
        setAzureStatus(data.message || 'Azure AD configuration saved!')
        setAzureForm(prev => ({ ...prev, ms_client_secret: '' }))
        fetchAzureConfig()
      }
    } catch (err) {
      setAzureStatus(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
    setAzureSaving(false)
  }

  const saveToken = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!accessToken.trim()) return
    setLoading(true)
    setStatus('Saving token...')
    try {
      const res = await fetch(MANAGE_TOKEN_URL, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': supabaseAnonKey
        },
        body: JSON.stringify({ access_token: accessToken.trim() })
      })
      const data = await res.json()
      if (!res.ok) {
        setStatus(`Error: ${data.error || 'Failed to save token'}`)
      } else {
        setStatus(data.message || 'Token saved successfully! Status: active')
        setAccessToken('')
        fetchTokenStatus()
      }
    } catch (err) {
      setStatus(`Error: ${errorMessage(err)}`)
    }
    setLoading(false)
  }

  const deleteToken = async () => {
    if (!confirm('Remove your Microsoft Graph token? You will need to reconnect to send emails.')) return
    setLoading(true)
    setStatus('Removing token...')
    try {
      const res = await fetch(MANAGE_TOKEN_URL, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${session.access_token}`, 'apikey': supabaseAnonKey }
      })
      const data = await res.json()
      if (!res.ok) {
        setStatus(`Error: ${data.error || 'Failed to delete token'}`)
      } else {
        setStatus('Token removed')
        setTokenStatus(null)
        setAccessToken('')
      }
    } catch (err) {
      setStatus(`Error: ${errorMessage(err)}`)
    }
    setLoading(false)
  }

  const statusColor = () => {
    if (!tokenStatus || !tokenStatus.has_token) return 'text-red-600 bg-red-50'
    if (tokenStatus.status === 'token_expired') return 'text-red-600 bg-red-50'
    if (tokenStatus.retry_after && new Date(tokenStatus.retry_after) > new Date()) return 'text-yellow-600 bg-yellow-50'
    if (!tokenStatus.has_refresh_token) return 'text-orange-600 bg-orange-50'
    return 'text-green-600 bg-green-50'
  }

  const statusText = () => {
    if (!tokenStatus || !tokenStatus.has_token) return 'No token configured'
    if (tokenStatus.status === 'token_expired') {
      return tokenStatus.has_refresh_token
        ? 'Token expired - will auto-refresh on next send'
        : 'Token expired - please reconnect or paste a new access token'
    }
    if (tokenStatus.retry_after && new Date(tokenStatus.retry_after) > new Date()) {
      const mins = Math.ceil((new Date(tokenStatus.retry_after).getTime() - Date.now()) / 60000)
      return `Rate limited - retry in ${mins} min`
    }
    const refreshInfo = tokenStatus.has_refresh_token ? ' (auto-refresh enabled)' : ' (no auto-refresh - will expire)'
    const expiryInfo = tokenStatus.expires_at
      ? ` | expires: ${new Date(tokenStatus.expires_at).toLocaleTimeString()}`
      : ''
    return `Active (sends today: ${tokenStatus.send_count ?? 0})${expiryInfo}${refreshInfo}`
  }

  // Smart detection: what connection method is available?
  const hasAzureAD = azureConfig?.has_config || azureConfig?.has_env_fallback
  const oauthAvailable = !!hasAzureAD

  return (
    <div className="bg-white p-6 rounded shadow max-w-2xl space-y-6">
      <h2 className="text-lg font-bold">Settings</h2>

      {/* ===== Section 1: Microsoft Graph Token ===== */}
      <div>
        <h3 className="text-md font-semibold mb-3 text-gray-800 border-b pb-1">Microsoft Graph Token</h3>

        {tokenStatus && (
          <div className={`p-3 rounded mb-4 text-sm font-medium ${statusColor()}`}>
            Status: {statusText()}
          </div>
        )}

        {/* Smart connection method selector */}
        <div className="mb-4 space-y-4">
          {/* Method A: OAuth (when Azure AD is configured) */}
          {oauthAvailable ? (
            <div className="p-4 bg-green-50 rounded border border-green-200">
              <div className="flex items-center gap-2 mb-2">
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-600 text-white text-xs font-bold">A</span>
                <h4 className="font-medium text-green-800">Sign in with Microsoft (Recommended)</h4>
              </div>
              <p className="text-sm text-green-700 mb-3">
                Your organization has an Azure AD app configured. Sign in once and tokens refresh automatically — no authenticator required, tokens last 90 days.
              </p>
              <button
                onClick={startOAuthFlow}
                disabled={oauthLoading}
                className="bg-blue-600 text-white py-2 px-4 rounded hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
              >
                {oauthLoading ? (
                  <span>Connecting...</span>
                ) : (
                  <svg className="w-5 h-5" viewBox="0 0 21 21" fill="none"><path d="M1 1h9v9H1z" fill="#f25022"/><path d="M11 1h9v9h-9z" fill="#7fba00"/><path d="M1 11h9v9H1z" fill="#00a4ef"/><path d="M11 11h9v9h-9z" fill="#ffb900"/></svg>
                )}
                {oauthLoading ? 'Connecting...' : 'Connect with Microsoft'}
              </button>
              {tokenStatus?.has_refresh_token && (
                <p className="mt-2 text-xs text-green-700 font-medium">
                  Auto-refresh is active — tokens will be refreshed automatically.
                </p>
              )}
            </div>
          ) : (
            <div className="border border-orange-200 rounded-lg overflow-hidden">
              {/* Header */}
              <div className="bg-orange-500 text-white p-3">
                <div className="flex items-center gap-2">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>
                  <h4 className="font-bold">Azure AD Setup Required for OAuth Sign-In</h4>
                </div>
                <p className="text-xs text-orange-100 mt-1">Follow these steps once to enable one-click Microsoft sign-in for your whole team. Takes ~5 minutes.</p>
              </div>

              <div className="p-4 space-y-4 text-sm">
                {/* Step 1 */}
                <div>
                  <h5 className="font-bold text-gray-800 mb-1">Step 1: Open Azure Portal</h5>
                  <ol className="list-decimal list-inside text-gray-600 text-xs space-y-1 ml-2">
                    <li>Go to <a href="https://portal.azure.com" target="_blank" rel="noreferrer" className="text-blue-600 underline font-medium">portal.azure.com</a> and sign in with your Microsoft work account</li>
                    <li>Search for <strong>"Azure Active Directory"</strong> and click it</li>
                    <li>In the left sidebar, click <strong>"App registrations"</strong> then <strong>"New registration"</strong></li>
                  </ol>
                </div>

                {/* Step 2 */}
                <div>
                  <h5 className="font-bold text-gray-800 mb-1">Step 2: Fill in the Registration</h5>
                  <div className="bg-white border rounded overflow-hidden text-xs mt-1">
                    <table className="w-full">
                      <tbody>
                        <tr className="border-b">
                          <td className="p-2 font-medium text-gray-700 bg-gray-50 w-1/3">Name</td>
                          <td className="p-2 font-mono text-gray-600">GemEng Email Service (or whatever you like)</td>
                        </tr>
                        <tr className="border-b">
                          <td className="p-2 font-medium text-gray-700 bg-gray-50">Supported account types</td>
                          <td className="p-2 text-gray-600">Single tenant — "Accounts in this organizational directory only"</td>
                        </tr>
                        <tr>
                          <td className="p-2 font-medium text-gray-700 bg-gray-50">Redirect URI</td>
                          <td className="p-2">
                            <span className="font-medium">Platform:</span> <span className="bg-yellow-100 text-yellow-800 px-1 rounded font-bold">Web</span> (NOT SPA!)
                            <br />
                            <span className="font-mono text-xs break-all bg-gray-100 px-1 py-0.5 rounded select-all">https://dsrsctzumggkrmyuwodw.supabase.co/functions/v1/ms-auth/callback</span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">Click <strong>Register</strong>.</p>
                </div>

                {/* Step 3 */}
                <div>
                  <h5 className="font-bold text-gray-800 mb-1">Step 3: Get Your Credentials</h5>
                  <p className="text-xs text-gray-600">After registration, you'll see the <strong>Overview</strong> page. Copy these two values:</p>
                  <ol className="list-decimal list-inside text-gray-600 text-xs space-y-1 ml-2 mt-1">
                    <li><strong>Application (client) ID</strong> — this is your Client ID</li>
                    <li><strong>Directory (tenant) ID</strong> — this is your Tenant ID</li>
                  </ol>
                </div>

                {/* Step 4 */}
                <div>
                  <h5 className="font-bold text-gray-800 mb-1">Step 4: Create a Client Secret</h5>
                  <ol className="list-decimal list-inside text-gray-600 text-xs space-y-1 ml-2">
                    <li>Go to <strong>Certificates & secrets</strong> in the left sidebar</li>
                    <li>Click <strong>New client secret</strong></li>
                    <li>Description: <span className="font-mono">Supabase Edge Functions</span></li>
                    <li>Expires: <strong>24 months</strong> (maximum)</li>
                    <li>Click <strong>Add</strong> then <strong className="text-red-600">copy the Value immediately</strong> (it's hidden after you leave the page!)</li>
                  </ol>
                </div>

                {/* Step 5 */}
                <div>
                  <h5 className="font-bold text-gray-800 mb-1">Step 5: Add API Permissions</h5>
                  <ol className="list-decimal list-inside text-gray-600 text-xs space-y-1 ml-2">
                    <li>Go to <strong>API permissions</strong> in the left sidebar</li>
                    <li>Click <strong>Add a permission</strong> → <strong>Microsoft Graph</strong> → <strong>Delegated permissions</strong></li>
                    <li>Add these permissions:
                      <div className="bg-white border rounded p-2 mt-1 ml-3 inline-block">
                        <div className="font-mono space-y-0.5">
                          <div>Mail.Send</div>
                          <div>Mail.ReadWrite</div>
                          <div>Mail.ReadBasic</div>
                          <div>User.Read</div>
                          <div>User.ReadBasic.All</div>
                          <div>offline_access</div>
                        </div>
                      </div>
                    </li>
                    <li className="text-orange-700 font-bold mt-1">Click <strong>"Grant admin consent for [your org]"</strong> and click <strong>Yes</strong> — THIS IS CRITICAL!</li>
                  </ol>
                  <p className="text-xs text-gray-500 mt-1">Without admin consent, each user gets prompted to consent individually, which may trigger authenticator prompts and limit refresh tokens to 24 hours.</p>
                </div>

                {/* Step 6 */}
                <div>
                  <h5 className="font-bold text-gray-800 mb-1">Step 6: Update Your Supabase Database</h5>
                  <p className="text-xs text-gray-600 mb-2">Once you have the 3 values, you can either use the form below or run this SQL in the Supabase SQL Editor:</p>
                  <div className="bg-gray-900 text-green-400 rounded p-2 font-mono text-xs overflow-x-auto">
                    <pre>{`UPDATE tenants
SET
  ms_client_id = 'YOUR_CLIENT_ID',
  ms_client_secret = 'YOUR_CLIENT_SECRET',
  ms_tenant_id = 'YOUR_TENANT_ID'
WHERE id = 'YOUR_TENANT_ID';`}</pre>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">Or set them as <strong>Supabase environment variables</strong> (Project Settings → Edge Functions → Function Secrets):</p>
                  <div className="bg-gray-900 text-green-400 rounded p-2 font-mono text-xs mt-1">
                    <div>MS_CLIENT_ID=YOUR_CLIENT_ID</div>
                    <div>MS_CLIENT_SECRET=YOUR_CLIENT_SECRET</div>
                    <div>MS_TENANT_ID=YOUR_TENANT_ID</div>
                  </div>
                </div>

                {/* Step 7 — Supabase edge function config */}
                <div>
                  <h5 className="font-bold text-gray-800 mb-1">Step 7: Supabase Edge Function Settings</h5>
                  <p className="text-xs text-gray-600 mb-2">After deploying the <code className="bg-gray-100 px-1 rounded">ms-auth</code> edge function, you MUST do these two things in the Supabase Dashboard:</p>
                  <div className="space-y-2">
                    <div className="bg-red-50 border border-red-200 rounded p-2">
                      <p className="text-xs text-red-800 font-bold">Turn OFF "Verify JWT" for ms-auth</p>
                      <p className="text-xs text-red-700 mt-0.5">Supabase Dashboard → Edge Functions → ms-auth → Settings → <strong>Verify JWT = OFF</strong></p>
                      <p className="text-xs text-red-600 mt-0.5">Why: Microsoft redirects to your callback URL <strong>without a JWT</strong>. If this is ON, the callback is blocked with "Missing authorization header" and the OAuth flow fails completely.</p>
                    </div>
                    <div className="bg-yellow-50 border border-yellow-200 rounded p-2">
                      <p className="text-xs text-yellow-800 font-bold">Set FRONTEND_URL secret</p>
                      <p className="text-xs text-yellow-700 mt-0.5">Project Settings (⚙️ gear icon, bottom left) → Edge Functions → Function Secrets → Add:</p>
                      <p className="text-xs font-mono mt-0.5">FRONTEND_URL = https://your-app.vercel.app</p>
                      <p className="text-xs text-yellow-600 mt-0.5">Why: After Microsoft login, the callback needs to redirect the user back to your app. Without this, users land on a blank Supabase page instead.</p>
                    </div>
                  </div>
                </div>

                {/* Common Mistakes */}
                <div className="bg-gray-800 text-white rounded p-3">
                  <h5 className="font-bold text-xs mb-2">Common Mistakes to Avoid</h5>
                  <div className="space-y-2 text-xs">
                    <div className="flex gap-2">
                      <span className="text-red-400 shrink-0">✗</span>
                      <p>Adding the redirect URI under <strong>"Expose an API" → "Application ID URI"</strong> — this will fail with "Values of IdentifierUris property must use a verified domain". The redirect URI goes under <strong>"Authentication" → "Add a platform" → "Web"</strong> only.</p>
                    </div>
                    <div className="flex gap-2">
                      <span className="text-red-400 shrink-0">✗</span>
                      <p>Choosing platform type <strong>"SPA"</strong> instead of <strong>"Web"</strong> — SPA uses a different auth flow. Our app uses server-side Authorization Code Flow with PKCE, which requires the <strong>Web</strong> platform.</p>
                    </div>
                    <div className="flex gap-2">
                      <span className="text-red-400 shrink-0">✗</span>
                      <p>Adding query parameters to the redirect URI (e.g. <code className="bg-gray-700 px-1 rounded">?user_id=...</code>) — Azure AD requires an <strong>exact match</strong>. Use only the exact URL shown above.</p>
                    </div>
                    <div className="flex gap-2">
                      <span className="text-red-400 shrink-0">✗</span>
                      <p>Forgetting to <strong>"Grant admin consent"</strong> — without it, refresh tokens last only 24 hours and users may need authenticator prompts.</p>
                    </div>
                    <div className="flex gap-2">
                      <span className="text-red-400 shrink-0">✗</span>
                      <p>Leaving <strong>"Verify JWT" ON</strong> for the ms-auth edge function — Microsoft's callback has no JWT, so the request is blocked.</p>
                    </div>
                  </div>
                </div>

                {/* Why This Fixes the Authenticator Problem */}
                <div className="bg-blue-50 border border-blue-200 rounded p-3">
                  <h5 className="font-bold text-blue-800 text-xs mb-1">Why This Fixes the Authenticator Problem</h5>
                  <div className="overflow-hidden text-xs">
                    <table className="w-full">
                      <thead>
                        <tr>
                          <th className="text-left p-1 font-medium"></th>
                          <th className="text-left p-1 font-medium text-green-700">Your Azure AD App</th>
                          <th className="text-left p-1 font-medium text-orange-700">Without Azure AD</th>
                        </tr>
                      </thead>
                      <tbody className="text-gray-600">
                        <tr className="border-t border-blue-200">
                          <td className="p-1 font-medium">Auth prompt</td>
                          <td className="p-1 text-green-700">Simple username/password + admin consent</td>
                          <td className="p-1 text-orange-700">Device code / Authenticator required</td>
                        </tr>
                        <tr className="border-t border-blue-200">
                          <td className="p-1 font-medium">Client secret</td>
                          <td className="p-1 text-green-700">Supported (confidential client)</td>
                          <td className="p-1 text-orange-700">Not supported (public client)</td>
                        </tr>
                        <tr className="border-t border-blue-200">
                          <td className="p-1 font-medium">Refresh token lifetime</td>
                          <td className="p-1 text-green-700">90 days with admin consent</td>
                          <td className="p-1 text-orange-700">24 hours max</td>
                        </tr>
                        <tr className="border-t border-blue-200">
                          <td className="p-1 font-medium">offline_access</td>
                          <td className="p-1 text-green-700">Guaranteed with admin consent</td>
                          <td className="p-1 text-orange-700">Unreliable</td>
                        </tr>
                        <tr className="border-t border-blue-200">
                          <td className="p-1 font-medium">Token refresh</td>
                          <td className="p-1 text-green-700">Works for months</td>
                          <td className="p-1 text-orange-700">Breaks after 24h</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-blue-700 mt-2">Because you register a <strong>confidential client</strong> (with a client secret) and <strong>grant admin consent</strong>, users in your org won't need an authenticator — they just sign in once with their email/password, and the refresh token keeps things working automatically.</p>
                </div>
              </div>
            </div>
          )}

          {/* Method B: Manual token paste (always available) */}
          <details className={!oauthAvailable ? '' : ''}>
            <summary className={`text-sm cursor-pointer hover:text-gray-700 font-medium ${!oauthAvailable ? 'text-blue-600' : 'text-gray-500'}`}>
              {!oauthAvailable ? 'Option A: Manual Token (Quick Start — no Azure AD needed)' : 'Option B: Manual Token Paste (Fallback)'}
            </summary>
            <div className="mt-3 p-3 bg-gray-50 rounded border border-gray-200">
              <p className="text-xs text-gray-600 mb-2">
                {!oauthAvailable
                  ? 'No Azure AD? No problem. Get a token from Microsoft Graph Explorer and paste it here. Tokens expire in 60-90 minutes, so you\'ll need to refresh manually.'
                  : 'If OAuth sign-in isn\'t working, you can paste a token manually. Tokens expire in 60-90 minutes.'}
              </p>
              <form onSubmit={saveToken} className="space-y-3">
                <div>
                  <label className="block text-sm font-medium mb-1">Access Token</label>
                  <textarea value={accessToken} onChange={e => setAccessToken(e.target.value)}
                    rows={4} className="w-full border p-2 rounded text-sm font-mono" placeholder="Paste your Microsoft Graph access token here..." />
                  <p className="text-xs text-gray-500 mt-1">
                    Get a token from{' '}
                    <a href="https://developer.microsoft.com/en-us/graph/graph-explorer" target="_blank" rel="noreferrer" className="text-blue-600 underline">Microsoft Graph Explorer</a>
                  </p>
                </div>
                <div className="flex gap-2">
                  <button type="submit" disabled={loading || !accessToken.trim()} className="flex-1 bg-gray-800 text-white py-2 rounded disabled:opacity-50 text-sm">
                    {loading ? 'Saving...' : 'Save Token'}
                  </button>
                  {tokenStatus?.has_token && (
                    <button type="button" onClick={deleteToken} disabled={loading}
                      className="bg-red-600 text-white py-2 px-4 rounded disabled:opacity-50 text-sm">
                      Remove
                    </button>
                  )}
                </div>
              </form>
            </div>
          </details>

          {/* Comparison table */}
          <div className="bg-gray-50 rounded border border-gray-200 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-100">
                  <th className="text-left p-2 font-medium text-gray-700"></th>
                  <th className="text-left p-2 font-medium text-green-700">With Azure AD</th>
                  <th className="text-left p-2 font-medium text-orange-700">Without Azure AD</th>
                </tr>
              </thead>
              <tbody className="text-gray-600">
                <tr className="border-t border-gray-200">
                  <td className="p-2 font-medium">Sign-in</td>
                  <td className="p-2">One-click OAuth</td>
                  <td className="p-2">Copy/paste token manually</td>
                </tr>
                <tr className="border-t border-gray-200">
                  <td className="p-2 font-medium">Authenticator</td>
                  <td className="p-2 text-green-700">Not required</td>
                  <td className="p-2 text-orange-700">May be required</td>
                </tr>
                <tr className="border-t border-gray-200">
                  <td className="p-2 font-medium">Token lifetime</td>
                  <td className="p-2">90 days (auto-refresh)</td>
                  <td className="p-2">60-90 minutes (manual)</td>
                </tr>
                <tr className="border-t border-gray-200">
                  <td className="p-2 font-medium">Batch emails</td>
                  <td className="p-2 text-green-700">Never get stuck</td>
                  <td className="p-2 text-orange-700">Stuck when token expires mid-batch</td>
                </tr>
                <tr className="border-t border-gray-200">
                  <td className="p-2 font-medium">Cost</td>
                  <td className="p-2">Free (Azure AD is included)</td>
                  <td className="p-2">Free (but manual work)</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {status && (
          <div className={`mt-3 p-2 rounded text-sm ${status.startsWith('Error') ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-800'}`}>
            {status}
          </div>
        )}
      </div>

      {/* ===== Section 2: Azure AD App Configuration (Admin Only) ===== */}
      {userRole === 'admin' && (
        <div>
          <div className="flex items-center justify-between border-b pb-1">
            <h3 className="text-md font-semibold text-gray-800">Azure AD App Configuration</h3>
            <button
              onClick={() => setShowSetupGuide(!showSetupGuide)}
              className="text-sm text-blue-600 hover:underline font-medium"
            >
              {showSetupGuide ? 'Hide setup guide' : 'How to set up Azure AD (Step-by-Step Guide)'}
            </button>
          </div>

          {/* Quick fix for existing apps — redirect URI help */}
          <div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded text-xs">
            <div className="flex items-center gap-1.5 mb-1">
              <svg className="w-4 h-4 text-yellow-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              <span className="font-bold text-yellow-800">Already registered your app? Make sure these are configured correctly!</span>
            </div>
            <div className="space-y-2 mt-1">
              <div>
                <p className="text-yellow-700 font-bold">1. Redirect URI (Azure Portal)</p>
                <p className="text-yellow-700">Go to <strong>Azure Portal → App registrations → your app → Authentication</strong>. Add a <strong>Web</strong> platform redirect URI:</p>
                <div className="bg-white border rounded p-2 font-mono text-xs select-all break-all">
                  https://dsrsctzumggkrmyuwodw.supabase.co/functions/v1/ms-auth/callback
                </div>
                <p className="text-red-600 font-bold mt-1">
                  Do NOT add this under "Expose an API" → "Application ID URI". It goes under "Authentication" → "Add a platform" → "Web" only. Do NOT add query parameters like ?user_id=...
                </p>
              </div>
              <div>
                <p className="text-yellow-700 font-bold">2. Verify JWT = OFF (Supabase Dashboard)</p>
                <p className="text-yellow-700">Edge Functions → ms-auth → Settings → <strong>Verify JWT = OFF</strong>. Microsoft's callback has no JWT — if this is ON, OAuth fails.</p>
              </div>
              <div>
                <p className="text-yellow-700 font-bold">3. FRONTEND_URL secret (Supabase Dashboard)</p>
                <p className="text-yellow-700">Project Settings (⚙️) → Edge Functions → Function Secrets → <code className="bg-white px-1 rounded">FRONTEND_URL = https://your-app.vercel.app</code>. Without this, users land on a blank page after login.</p>
              </div>
            </div>
          </div>

          {/* Current config status */}
          {azureConfig && (
            <div className={`p-3 rounded mt-3 mb-4 text-sm font-medium ${
              azureConfig.has_config
                ? 'text-green-700 bg-green-50 border border-green-200'
                : azureConfig.has_env_fallback
                  ? 'text-blue-700 bg-blue-50 border border-blue-200'
                  : 'text-red-700 bg-red-50 border border-red-200'
            }`}>
              {azureConfig.has_config ? (
                <>
                  Your organization's Azure AD app is configured
                  <span className="block text-xs font-normal mt-1">
                    Client ID: {azureConfig.ms_client_id} | Tenant: {azureConfig.ms_tenant_id}
                    {azureConfig.ms_client_secret_masked && ` | Secret: ${azureConfig.ms_client_secret_masked}`}
                  </span>
                </>
              ) : azureConfig.has_env_fallback ? (
                <>
                  Using platform-level Azure AD app (env vars)
                  <span className="block text-xs font-normal mt-1">
                    This works for one domain. Configure tenant-specific credentials below for multi-domain support.
                  </span>
                </>
              ) : (
                <>
                  No Azure AD app configured
                  <span className="block text-xs font-normal mt-1">
                    OAuth sign-in won't work until you register an Azure AD app. Follow the setup guide below.
                  </span>
                </>
              )}
            </div>
          )}

          {/* Full step-by-step setup guide */}
          {showSetupGuide && (
            <div className="mb-4 border border-blue-200 rounded-lg overflow-hidden">
              <div className="bg-blue-600 text-white p-3">
                <h4 className="font-bold text-sm">Step-by-Step: Register Your Azure AD App (Free)</h4>
                <p className="text-xs text-blue-100 mt-1">This takes about 5 minutes and eliminates the need for authenticator apps and manual token pasting.</p>
              </div>

              <div className="p-4 space-y-4 text-sm">
                {/* Step 1 */}
                <div>
                  <h5 className="font-bold text-gray-800 mb-1">Step 1: Open Azure Portal</h5>
                  <ol className="list-decimal list-inside text-gray-600 text-xs space-y-1 ml-2">
                    <li>Go to <a href="https://portal.azure.com" target="_blank" rel="noreferrer" className="text-blue-600 underline">portal.azure.com</a> and sign in with your Microsoft work account</li>
                    <li>Search for <strong>"Azure Active Directory"</strong> and click it</li>
                    <li>In the left sidebar, click <strong>"App registrations"</strong> then <strong>"New registration"</strong></li>
                  </ol>
                </div>

                {/* Step 2 */}
                <div>
                  <h5 className="font-bold text-gray-800 mb-1">Step 2: Fill in the Registration</h5>
                  <div className="bg-white border rounded overflow-hidden text-xs">
                    <table className="w-full">
                      <tbody>
                        <tr className="border-b">
                          <td className="p-2 font-medium text-gray-700 bg-gray-50 w-1/3">Name</td>
                          <td className="p-2 font-mono text-gray-600">GemEng Email Service (or whatever you like)</td>
                        </tr>
                        <tr className="border-b">
                          <td className="p-2 font-medium text-gray-700 bg-gray-50">Supported account types</td>
                          <td className="p-2 text-gray-600">Single tenant — "Accounts in this organizational directory only"</td>
                        </tr>
                        <tr>
                          <td className="p-2 font-medium text-gray-700 bg-gray-50">Redirect URI</td>
                          <td className="p-2">
                            <span className="font-medium">Platform:</span> <span className="bg-yellow-100 text-yellow-800 px-1 rounded font-bold">Web</span> (NOT SPA!)
                            <br />
                            <span className="font-mono text-xs break-all bg-gray-100 px-1 py-0.5 rounded select-all">https://dsrsctzumggkrmyuwodw.supabase.co/functions/v1/ms-auth/callback</span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">Click <strong>Register</strong>.</p>
                </div>

                {/* Step 3 */}
                <div>
                  <h5 className="font-bold text-gray-800 mb-1">Step 3: Get Your Credentials</h5>
                  <p className="text-xs text-gray-600">After registration, you'll see the <strong>Overview</strong> page. Copy these two values:</p>
                  <ol className="list-decimal list-inside text-gray-600 text-xs space-y-1 ml-2 mt-1">
                    <li><strong>Application (client) ID</strong> — this is your Client ID</li>
                    <li><strong>Directory (tenant) ID</strong> — this is your Tenant ID</li>
                  </ol>
                </div>

                {/* Step 4 */}
                <div>
                  <h5 className="font-bold text-gray-800 mb-1">Step 4: Create a Client Secret</h5>
                  <ol className="list-decimal list-inside text-gray-600 text-xs space-y-1 ml-2">
                    <li>Go to <strong>Certificates & secrets</strong> in the left sidebar</li>
                    <li>Click <strong>New client secret</strong></li>
                    <li>Description: <span className="font-mono">Supabase Edge Functions</span></li>
                    <li>Expires: <strong>24 months</strong> (maximum)</li>
                    <li>Click <strong>Add</strong> then <strong className="text-red-600">copy the Value immediately</strong> (it's hidden after you leave the page)</li>
                  </ol>
                </div>

                {/* Step 5 */}
                <div>
                  <h5 className="font-bold text-gray-800 mb-1">Step 5: Add API Permissions</h5>
                  <ol className="list-decimal list-inside text-gray-600 text-xs space-y-1 ml-2">
                    <li>Go to <strong>API permissions</strong> in the left sidebar</li>
                    <li>Click <strong>Add a permission</strong> → <strong>Microsoft Graph</strong> → <strong>Delegated permissions</strong></li>
                    <li>Add these permissions:
                      <div className="bg-white border rounded p-2 mt-1 ml-3 inline-block">
                        <div className="font-mono space-y-0.5">
                          <div>Mail.Send</div>
                          <div>Mail.ReadWrite</div>
                          <div>Mail.ReadBasic</div>
                          <div>User.Read</div>
                          <div>User.ReadBasic.All</div>
                          <div>offline_access</div>
                        </div>
                      </div>
                    </li>
                    <li className="text-orange-700 font-bold mt-1">Click <strong>"Grant admin consent for [your org]"</strong> and click <strong>Yes</strong> — THIS IS CRITICAL!</li>
                  </ol>
                  <p className="text-xs text-gray-500 mt-1">Without admin consent, each user gets prompted to consent individually, which may trigger authenticator prompts and limit refresh tokens to 24 hours.</p>
                </div>

                {/* Step 6 */}
                <div>
                  <h5 className="font-bold text-gray-800 mb-1">Step 6: Update Your Supabase Database</h5>
                  <p className="text-xs text-gray-600 mb-2">Once you have the 3 values, you can either use the form below or run this SQL in the Supabase SQL Editor:</p>
                  <div className="bg-gray-900 text-green-400 rounded p-2 font-mono text-xs overflow-x-auto">
                    <pre>{`UPDATE tenants
SET
  ms_client_id = 'YOUR_CLIENT_ID',
  ms_client_secret = 'YOUR_CLIENT_SECRET',
  ms_tenant_id = 'YOUR_TENANT_ID'
WHERE id = 'YOUR_TENANT_ID';`}</pre>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">Or set them as <strong>Supabase environment variables</strong> (Project Settings → Edge Functions → Function Secrets):</p>
                  <div className="bg-gray-900 text-green-400 rounded p-2 font-mono text-xs mt-1">
                    <div>MS_CLIENT_ID=YOUR_CLIENT_ID</div>
                    <div>MS_CLIENT_SECRET=YOUR_CLIENT_SECRET</div>
                    <div>MS_TENANT_ID=YOUR_TENANT_ID</div>
                  </div>
                </div>

                {/* Step 7 — Supabase edge function config */}
                <div>
                  <h5 className="font-bold text-gray-800 mb-1">Step 7: Supabase Edge Function Settings</h5>
                  <p className="text-xs text-gray-600 mb-2">After deploying the <code className="bg-gray-100 px-1 rounded">ms-auth</code> edge function, you MUST do these two things in the Supabase Dashboard:</p>
                  <div className="space-y-2">
                    <div className="bg-red-50 border border-red-200 rounded p-2">
                      <p className="text-xs text-red-800 font-bold">Turn OFF "Verify JWT" for ms-auth</p>
                      <p className="text-xs text-red-700 mt-0.5">Supabase Dashboard → Edge Functions → ms-auth → Settings → <strong>Verify JWT = OFF</strong></p>
                      <p className="text-xs text-red-600 mt-0.5">Why: Microsoft redirects to your callback URL <strong>without a JWT</strong>. If this is ON, the callback is blocked with "Missing authorization header" and the OAuth flow fails completely.</p>
                    </div>
                    <div className="bg-yellow-50 border border-yellow-200 rounded p-2">
                      <p className="text-xs text-yellow-800 font-bold">Set FRONTEND_URL secret</p>
                      <p className="text-xs text-yellow-700 mt-0.5">Project Settings (⚙️ gear icon, bottom left) → Edge Functions → Function Secrets → Add:</p>
                      <p className="text-xs font-mono mt-0.5">FRONTEND_URL = https://your-app.vercel.app</p>
                      <p className="text-xs text-yellow-600 mt-0.5">Why: After Microsoft login, the callback needs to redirect the user back to your app. Without this, users land on a blank Supabase page instead.</p>
                    </div>
                  </div>
                </div>

                {/* Common Mistakes */}
                <div className="bg-gray-800 text-white rounded p-3">
                  <h5 className="font-bold text-xs mb-2">Common Mistakes to Avoid</h5>
                  <div className="space-y-2 text-xs">
                    <div className="flex gap-2">
                      <span className="text-red-400 shrink-0">✗</span>
                      <p>Adding the redirect URI under <strong>"Expose an API" → "Application ID URI"</strong> — this will fail with "Values of IdentifierUris property must use a verified domain". The redirect URI goes under <strong>"Authentication" → "Add a platform" → "Web"</strong> only.</p>
                    </div>
                    <div className="flex gap-2">
                      <span className="text-red-400 shrink-0">✗</span>
                      <p>Choosing platform type <strong>"SPA"</strong> instead of <strong>"Web"</strong> — SPA uses a different auth flow. Our app uses server-side Authorization Code Flow with PKCE, which requires the <strong>Web</strong> platform.</p>
                    </div>
                    <div className="flex gap-2">
                      <span className="text-red-400 shrink-0">✗</span>
                      <p>Adding query parameters to the redirect URI (e.g. <code className="bg-gray-700 px-1 rounded">?user_id=...</code>) — Azure AD requires an <strong>exact match</strong>. Use only the exact URL shown above.</p>
                    </div>
                    <div className="flex gap-2">
                      <span className="text-red-400 shrink-0">✗</span>
                      <p>Forgetting to <strong>"Grant admin consent"</strong> — without it, refresh tokens last only 24 hours and users may need authenticator prompts.</p>
                    </div>
                    <div className="flex gap-2">
                      <span className="text-red-400 shrink-0">✗</span>
                      <p>Leaving <strong>"Verify JWT" ON</strong> for the ms-auth edge function — Microsoft's callback has no JWT, so the request is blocked.</p>
                    </div>
                  </div>
                </div>

                {/* Why This Fixes the Authenticator Problem */}
                <div className="bg-blue-50 border border-blue-200 rounded p-3">
                  <h5 className="font-bold text-blue-800 text-xs mb-1">Why This Fixes the Authenticator Problem</h5>
                  <div className="overflow-hidden text-xs">
                    <table className="w-full">
                      <thead>
                        <tr>
                          <th className="text-left p-1 font-medium"></th>
                          <th className="text-left p-1 font-medium text-green-700">Your Azure AD App</th>
                          <th className="text-left p-1 font-medium text-orange-700">Without Azure AD</th>
                        </tr>
                      </thead>
                      <tbody className="text-gray-600">
                        <tr className="border-t border-blue-200">
                          <td className="p-1 font-medium">Auth prompt</td>
                          <td className="p-1 text-green-700">Simple username/password + admin consent</td>
                          <td className="p-1 text-orange-700">Device code / Authenticator required</td>
                        </tr>
                        <tr className="border-t border-blue-200">
                          <td className="p-1 font-medium">Client secret</td>
                          <td className="p-1 text-green-700">Supported (confidential client)</td>
                          <td className="p-1 text-orange-700">Not supported (public client)</td>
                        </tr>
                        <tr className="border-t border-blue-200">
                          <td className="p-1 font-medium">Refresh token lifetime</td>
                          <td className="p-1 text-green-700">90 days with admin consent</td>
                          <td className="p-1 text-orange-700">24 hours max</td>
                        </tr>
                        <tr className="border-t border-blue-200">
                          <td className="p-1 font-medium">offline_access</td>
                          <td className="p-1 text-green-700">Guaranteed with admin consent</td>
                          <td className="p-1 text-orange-700">Unreliable</td>
                        </tr>
                        <tr className="border-t border-blue-200">
                          <td className="p-1 font-medium">Token refresh</td>
                          <td className="p-1 text-green-700">Works for months</td>
                          <td className="p-1 text-orange-700">Breaks after 24h</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-blue-700 mt-2">Because you register a <strong>confidential client</strong> (with a client secret) and <strong>grant admin consent</strong>, users in your org won't need an authenticator — they just sign in once with their email/password, and the refresh token keeps things working automatically.</p>
                </div>
              </div>
            </div>
          )}

          {/* Config form */}
          <form onSubmit={saveAzureConfig} className="space-y-3">
            <div>
              <label className="block text-sm font-medium mb-1">Application (Client) ID</label>
              <input
                type="text"
                value={azureForm.ms_client_id}
                onChange={e => setAzureForm(prev => ({ ...prev, ms_client_id: e.target.value }))}
                className="w-full border p-2 rounded text-sm font-mono"
                placeholder="e.g. 3541a59f-8159-4b09-ad63-a60bcab03ec9"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Client Secret</label>
              <input
                type="password"
                value={azureForm.ms_client_secret}
                onChange={e => setAzureForm(prev => ({ ...prev, ms_client_secret: e.target.value }))}
                className="w-full border p-2 rounded text-sm font-mono"
                placeholder={azureConfig?.ms_client_secret_set ? 'Enter new secret to replace existing one' : 'Enter client secret value'}
                required={!azureConfig?.ms_client_secret_set}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Directory (Tenant) ID</label>
              <input
                type="text"
                value={azureForm.ms_tenant_id}
                onChange={e => setAzureForm(prev => ({ ...prev, ms_tenant_id: e.target.value }))}
                className="w-full border p-2 rounded text-sm font-mono"
                placeholder="e.g. 3780d0ca-6921-4bcd-83a9-b8a47bf74088"
                required
              />
            </div>

            <button
              type="submit"
              disabled={azureSaving || (!azureForm.ms_client_id.trim() && !azureForm.ms_tenant_id.trim())}
              className="bg-indigo-600 text-white py-2 px-4 rounded hover:bg-indigo-700 disabled:opacity-50 text-sm"
            >
              {azureSaving ? 'Saving...' : 'Save Azure AD Configuration'}
            </button>
          </form>

          {azureStatus && (
            <div className={`mt-3 p-2 rounded text-sm ${azureStatus.startsWith('Error') ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-800'}`}>
              {azureStatus}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

interface Invitation {
  id: string
  tenant_id: string
  email: string
  role: string
  status: string
  invited_by: string | null
  created_at: string
}

function InvitationsTab({ session }: { session: Session }) {
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [loading, setLoading] = useState(true)
  const [newEmail, setNewEmail] = useState('')
  const [newRole, setNewRole] = useState('member')
  const [inviting, setInviting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const fetchInvitations = async () => {
    setLoading(true)
    const { data: membership } = await supabase
      .from('memberships')
      .select('tenant_id, role')
      .eq('user_id', session.user.id)
      .single()

    if (!membership || membership.role !== 'admin') {
      setLoading(false)
      return
    }

    const { data } = await supabase
      .from('invitations')
      .select('*')
      .or(`tenant_id.eq.${membership.tenant_id},tenant_id.is.null`)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })

    if (data) setInvitations(data)
    setLoading(false)
  }

  useEffect(() => {
    fetchInvitations()
  }, [session.user.id])

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newEmail.trim()) return

    setInviting(true)
    setError('')
    setSuccess('')

    try {
      const { data: membership } = await supabase
        .from('memberships')
        .select('tenant_id')
        .eq('user_id', session.user.id)
        .single()

      if (!membership) throw new Error('Not a member of any tenant')

      const { error: inviteError } = await supabase
        .from('invitations')
        .insert({
          tenant_id: membership.tenant_id,
          email: newEmail.toLowerCase().trim(),
          role: newRole,
          invited_by: session.user.id,
          status: 'pending'
        })

      if (inviteError) {
        if (inviteError.message.includes('duplicate')) {
          throw new Error('An invitation for this email already exists')
        }
        throw inviteError
      }

      setSuccess(`Invitation sent to ${newEmail}! They will receive an email with signup instructions.`)
      setNewEmail('')
      fetchInvitations()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send invitation')
    }
    setInviting(false)
  }

  const handleApprove = async (invitation: Invitation) => {
    try {
      // Get admin's tenant_id to add the user to
      const { data: adminMembership } = await supabase
        .from('memberships')
        .select('tenant_id')
        .eq('user_id', session.user.id)
        .eq('role', 'admin')
        .single()

      if (!adminMembership) {
        setError('You must be an admin to approve invitations')
        return
      }

      const { data: user } = await supabase
        .from('users')
        .select('id, email')
        .eq('email', invitation.email)
        .single()

      if (!user) {
        setError(`No user found with email ${invitation.email}. They need to sign up first.`)
        return
      }

      const { error: approveError } = await supabase
        .from('memberships')
        .insert({
          tenant_id: adminMembership.tenant_id, // Use admin's tenant, not invitation's
          user_id: user.id,
          role: invitation.role
        })

      if (approveError) {
        if (approveError.message.includes('duplicate')) {
          throw new Error('User is already a member')
        }
        throw approveError
      }

      const { error: markApprovedError } = await supabase
        .from('invitations')
        .update({ status: 'approved' })
        .eq('id', invitation.id)

      if (markApprovedError) {
        // Membership was created, so don't fail the whole approval --
        // but the user MUST know the invitation row is still pending.
        console.error('Failed to mark invitation approved:', markApprovedError)
        await fetchInvitations()
        setSuccess(`${invitation.email} has been approved, but marking the invitation as approved failed: ${errorMessage(markApprovedError)}`)
        return
      }

      // Auto-confirm user's email so they can login immediately
      const { error: confirmError } = await supabase.functions.invoke(CONFIRM_USER_URL, {
        body: { email: invitation.email }
      })
      if (confirmError) {
        console.error('Failed to confirm user email:', confirmError)
      }

      await fetchInvitations()
      setSuccess(`${invitation.email} has been approved! They can now access the app.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve')
    }
  }

  const handleReject = async (id: string) => {
    if (!confirm('Are you sure you want to reject this invitation?')) return

    const { error: rejectError } = await supabase
      .from('invitations')
      .update({ status: 'rejected' })
      .eq('id', id)

    if (rejectError) {
      setError('Failed to reject invitation')
    } else {
      fetchInvitations()
    }
  }

  const handleDelete = async (invitation: Invitation) => {
    if (!confirm(`Delete invitation for ${invitation.email}? This will remove their access to the team.`)) return

    setLoading(true)
    setError('')
    setSuccess('')
    try {
      // Find user's ID from public.users
      const { data: userData } = await supabase
        .from('users')
        .select('id')
        .eq('email', invitation.email)
        .single()

      if (userData) {
        // Delete membership
        const { error: membershipDeleteError } = await supabase
          .from('memberships')
          .delete()
          .eq('user_id', userData.id)
          .eq('tenant_id', invitation.tenant_id)
        if (membershipDeleteError) {
          setError(`Failed to remove membership: ${errorMessage(membershipDeleteError)}`)
          setLoading(false)
          return
        }

        // Delete from public.users
        const { error: userDeleteError } = await supabase
          .from('users')
          .delete()
          .eq('id', userData.id)
        if (userDeleteError) {
          setError(`Failed to remove user record: ${errorMessage(userDeleteError)}`)
          setLoading(false)
          return
        }
      }

      // Delete invitation
      const { error: deleteError } = await supabase
        .from('invitations')
        .delete()
        .eq('id', invitation.id)

      if (deleteError) {
        setError('Failed to delete invitation')
      } else {
        fetchInvitations()
        setSuccess(`Removed ${invitation.email} from the team. Note: Auth account must be deleted manually from Supabase dashboard.`)
      }
    } catch (err) {
      setError('Failed to delete: ' + (err instanceof Error ? err.message : 'Unknown error'))
    }
    setLoading(false)
  }

  const pendingInvitations = invitations.filter(i => i.status === 'pending')
  const processedInvitations = invitations.filter(i => i.status !== 'pending')

  return (
    <div className="bg-white p-6 rounded shadow">
      <h2 className="text-lg font-bold mb-4">Team Invitations</h2>

      <form onSubmit={handleInvite} className="flex flex-wrap gap-2 mb-6 p-4 bg-gray-50 rounded">
        <input
          type="email"
          placeholder="Email address to invite"
          value={newEmail}
          onChange={e => setNewEmail(e.target.value)}
          className="border p-2 rounded flex-1 min-w-64"
          required
        />
        <select
          value={newRole}
          onChange={e => setNewRole(e.target.value)}
          className="border p-2 rounded"
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button
          type="submit"
          disabled={inviting}
          className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
        >
          {inviting ? 'Sending...' : 'Send Invitation'}
        </button>
      </form>

      {error && <div className="mb-4 p-2 bg-red-100 text-red-700 rounded text-sm">{error}</div>}
      {success && <div className="mb-4 p-2 bg-green-100 text-green-700 rounded text-sm">{success}</div>}

      {loading ? (
        <p>Loading...</p>
      ) : (
        <>
          {pendingInvitations.length > 0 && (
            <div className="mb-6">
              <h3 className="font-medium mb-2 text-yellow-700">Pending Invitations</h3>
              <table className="min-w-full text-sm mb-4">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-2">Email</th>
                    <th className="text-left p-2">Role</th>
                    <th className="text-left p-2">Date</th>
                    <th className="text-left p-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingInvitations.map(inv => (
                    <tr key={inv.id} className="border-b">
                      <td className="p-2">{inv.email}</td>
                      <td className="p-2">{inv.role}</td>
                      <td className="p-2">{new Date(inv.created_at).toLocaleDateString()}</td>
                      <td className="p-2 flex gap-2">
                        <button
                          onClick={() => handleApprove(inv)}
                          className="text-green-600 hover:underline text-xs"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => handleReject(inv.id)}
                          className="text-red-600 hover:underline text-xs"
                        >
                          Reject
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {processedInvitations.length > 0 && (
            <div>
              <h3 className="font-medium mb-2 text-gray-600">Processed Invitations</h3>
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-2">Email</th>
                    <th className="text-left p-2">Role</th>
                    <th className="text-left p-2">Status</th>
                    <th className="text-left p-2">Date</th>
                    <th className="text-left p-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {processedInvitations.map(inv => (
                    <tr key={inv.id} className="border-b">
                      <td className="p-2">{inv.email}</td>
                      <td className="p-2">{inv.role}</td>
                      <td className="p-2">
                        <span className={`px-2 py-1 rounded-full text-xs ${
                          inv.status === 'approved' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                        }`}>
                          {inv.status}
                        </span>
                      </td>
                      <td className="p-2">{new Date(inv.created_at).toLocaleDateString()}</td>
                      <td className="p-2">
                        <button
                          onClick={() => handleDelete(inv)}
                          className="text-gray-600 hover:underline text-xs"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {invitations.length === 0 && (
            <p className="text-gray-400 text-center py-4">No invitations yet</p>
          )}
        </>
      )}
    </div>
  )
}