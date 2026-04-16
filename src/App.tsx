import { useState, useEffect } from 'react'
import { supabase } from './supabase'
import type { Session } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://dsrsctzumggkrmyuwodw.supabase.co'
const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/send-email-v3`

type AuthView = 'login' | 'signup' | 'pending' | 'invitation_required'

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
  const [activeTab, setActiveTab] = useState<'compose' | 'contacts' | 'history' | 'files' | 'lists' | 'settings' | 'invitations'>('compose')
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
  const [sendNow, setSendNow] = useState(true)
  const [sendAt, setSendAt] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)
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
  const [pendingCount, setPendingCount] = useState(0)
  const [scheduledCount, setScheduledCount] = useState(0)
  const [processingCount, setProcessingCount] = useState(0)

  const BUCKET_NAME = 'dfsdfsdf'

  useEffect(() => {
    if (!session?.user?.id) return
    const fetchFilesForPicker = async () => {
      const { data: membership } = await supabase.from('memberships').select('tenant_id').eq('user_id', session.user.id).single()
      if (!membership) return
      const { data } = await supabase.storage.from(BUCKET_NAME).list(membership.tenant_id, { limit: 100 })
      if (data) {
        setAvailableFiles(data.map(f => ({
          name: f.name,
          path: `${membership.tenant_id}/${f.name}`,
          size: f.metadata?.size || 0
        })))
      }
    }
    fetchFilesForPicker()
  }, [session?.user?.id])

  useEffect(() => {
    const fetchContacts = async () => {
      const { data: membership } = await supabase.from('memberships').select('tenant_id').eq('user_id', session.user.id).single()
      if (!membership) return
      const { data } = await supabase.from('contacts').select('email, name').eq('tenant_id', membership.tenant_id).neq('status', 'hardbounced')
      if (data) setContacts(data)

      const { data: listsData } = await supabase.from('lists').select('id, name').eq('tenant_id', membership.tenant_id).order('name')
      if (listsData) setLists(listsData)

      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
      
      const { count: scheduledCount } = await supabase
        .from('email_sends')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', membership.tenant_id)
        .eq('status', 'scheduled')
      
      const { count: processingCount } = await supabase
        .from('email_sends')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', membership.tenant_id)
        .eq('status', 'processing')
        .gt('created_at', fiveMinAgo)
      
      setPendingCount((scheduledCount || 0) + (processingCount || 0))
      setScheduledCount(scheduledCount || 0)
      setProcessingCount(processingCount || 0)
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

  const refreshFiles = () => {
    if (!session?.user?.id) return
    supabase.storage.from(BUCKET_NAME).list(session.user.id, { limit: 100 })
      .then(({ data }) => {
        if (data) {
          setAvailableFiles(data.map(f => ({
            name: f.name,
            path: `${session.user.id}/${f.name}`,
            size: f.metadata?.size || 0
          })))
        }
      })
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
    if (!fileToUpload || !session?.user?.id) return
    setUploadingFile(true)
    try {
      const ext = fileToUpload.name.split('.').pop()
      const baseName = fileToUpload.name.replace(`.${ext}`, '')
      const timestamp = Date.now()
      const uniquePath = `${session.user.id}/${timestamp}-${baseName}.${ext}`
      
      const { error } = await supabase.storage.from(BUCKET_NAME).upload(uniquePath, fileToUpload, {
        cacheControl: '3600',
        upsert: false
      })
      
      if (error) throw error
      
      addFile({ name: fileToUpload.name, path: uniquePath, size: fileToUpload.size })
      refreshFiles()
      setFileToUpload(null)
    } catch (err) {
      alert(`Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
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
    setStatus('Preparing...')

    try {
      const { data: membership } = await supabase
        .from('memberships')
        .select('tenant_id')
        .eq('user_id', session.user.id)
        .single()

      if (!membership) throw new Error('No tenant found')

      if (recipientMode === 'list' && selectedListId) {
        const { data: listContacts } = await supabase
          .from('contacts')
          .select('email')
          .eq('tenant_id', membership.tenant_id)
          .eq('list_id', selectedListId)
          .neq('status', 'hardbounced')

        if (!listContacts || listContacts.length === 0) {
          throw new Error('No contacts in this list')
        }

        const sendAtTime = sendNow ? null : new Date(sendAt).toISOString()
        const tracking_id = crypto.randomUUID()

        for (const contact of listContacts) {
          await supabase.from('email_sends').insert({
            tenant_id: membership.tenant_id,
            user_id: session.user.id,
            tracking_id,
            recipient_email: contact.email,
            subject,
            html_content: htmlContent,
            status: 'scheduled',
            send_at: sendAtTime
          })
        }

        if (sendNow) {
          await fetch(`${SUPABASE_URL}/functions/v1/process-emails-v3`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` }
          })
        }

        setStatus(`Email ${sendNow ? 'sent' : 'scheduled'} for ${listContacts.length} recipients!`)
      } else {
        const response = await fetch(EDGE_FUNCTION_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient_email: recipient,
            subject,
            html_content: htmlContent,
            attachments: selectedFiles,
            send_now: sendNow,
            send_at: sendNow ? null : new Date(sendAt).toISOString(),
            tenant_id: membership.tenant_id,
            user_id: session.user.id,
          }),
        })

        const data = await response.json()
        
        if (!response.ok) throw new Error(data.error || 'Failed to send')

        setStatus(sendNow ? 'Email sent successfully!' : 'Email scheduled successfully!')
      }

      setRecipient('')
      setSubject('')
      setHtmlContent('')
      setSelectedFiles([])
      setSelectedListId('')
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }

    setLoading(false)
  }

  return (
    <div className="bg-white p-6 rounded shadow">
      <form onSubmit={handleSubmit} className="space-y-4">
        {pendingCount > 0 && (
          <div className="bg-yellow-50 border border-yellow-200 p-2 rounded text-sm text-yellow-800">
            Pending emails: <strong>{pendingCount}</strong> ({scheduledCount} scheduled, {processingCount} processing) - new batch sends may be delayed due to rate limits
          </div>
        )}
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
          <p className="text-xs text-gray-500">Supports HTML. Links will be automatically tracked.</p>
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
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2">
            <input type="radio" checked={sendNow} onChange={() => setSendNow(true)} />
            Send Now
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={!sendNow} onChange={() => setSendNow(false)} />
            Schedule
          </label>
          {!sendNow && (
            <input type="datetime-local" value={sendAt} onChange={e => setSendAt(e.target.value)} className="border p-1 rounded" />
          )}
        </div>
        <button type="submit" disabled={loading} className="w-full bg-blue-600 text-white py-2 rounded">
          {loading ? 'Sending...' : (sendNow ? 'Send Email' : 'Schedule Email')}
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
  const [contacts, setContacts] = useState<Contact[]>([])
  const [lists, setLists] = useState<ContactList[]>([])
  const [loading, setLoading] = useState(true)
  const [newEmail, setNewEmail] = useState('')
  const [newName, setNewName] = useState('')
  const [newStatus, setNewStatus] = useState('subscribed')
  const [newListId, setNewListId] = useState('')
  const [searchEmail, setSearchEmail] = useState('')
  const [searchName, setSearchName] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterList, setFilterList] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [uploading, setUploading] = useState(false)

  const fetchData = async () => {
    setLoading(true)
    const { data: membership } = await supabase.from('memberships').select('tenant_id').eq('user_id', session.user.id).single()
    if (!membership) { setLoading(false); return }

    const [contactsRes, listsRes] = await Promise.all([
      supabase.from('contacts').select('*').eq('tenant_id', membership.tenant_id).order('created_at', { ascending: false }),
      supabase.from('lists').select('*').eq('tenant_id', membership.tenant_id).order('name')
    ])

    if (contactsRes.data) setContacts(contactsRes.data as Contact[])
    if (listsRes.data) setLists(listsRes.data as ContactList[])
    setLoading(false)
  }

  useEffect(() => {
    fetchData()
  }, [])

  useEffect(() => {
    if (filterListId) {
      setFilterList(filterListId)
    }
  }, [filterListId])

  useEffect(() => {
    fetchData()
  }, [session.user.id, refreshListsKey])

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
        await supabase.from('contacts').update(updates).eq('id', existing.id)
      }
    } else {
      await supabase.from('contacts').insert({
        tenant_id: membership.tenant_id,
        email: newEmail.toLowerCase(),
        name: newName.trim() || null,
        status: newStatus,
        list_id: newListId || null,
      })
    }

    setNewEmail('')
    setNewName('')
    setNewStatus('subscribed')
    setNewListId('')
    fetchData()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete contact?')) return
    await supabase.from('contacts').delete().eq('id', id)
    fetchData()
  }

  const handleBulkUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setUploading(true)
    try {
      const text = await file.text()
      const lines = text.split('\n').filter(l => l.trim())
      if (lines.length < 2) {
        alert('CSV file is empty or has no data rows')
        setUploading(false)
        return
      }

      const header = lines[0].toLowerCase().split(',').map(h => h.trim())
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

      let added = 0
      let updated = 0

      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map(c => c.trim())
        const email = cols[emailIdx]?.toLowerCase()
        if (!email) continue

        const name = nameIdx !== -1 ? cols[nameIdx] || null : null
        const statusVal = statusIdx !== -1 ? (cols[statusIdx]?.toLowerCase() || 'subscribed') : 'subscribed'
        const validStatus = ['subscribed', 'unsubscribed', 'hardbounced'].includes(statusVal) ? statusVal : 'subscribed'
        const listName = listIdx !== -1 ? cols[listIdx]?.toLowerCase() : null
        const listId = listName ? listNameToId[listName] || null : null

        const { data: existing } = await supabase
          .from('contacts')
          .select('id, name, status, list_id')
          .eq('tenant_id', membership.tenant_id)
          .eq('email', email)
          .single()

        if (existing) {
          const updates: Record<string, unknown> = {}
          if (name !== existing.name) updates.name = name
          if (validStatus !== existing.status) updates.status = validStatus
          if (listId !== existing.list_id) updates.list_id = listId

          if (Object.keys(updates).length > 0) {
            await supabase.from('contacts').update(updates).eq('id', existing.id)
            updated++
          }
        } else {
          await supabase.from('contacts').insert({
            tenant_id: membership.tenant_id,
            email,
            name,
            status: validStatus,
            list_id: listId,
          })
          added++
        }
      }

      alert(`Import complete: ${added} added, ${updated} updated`)
      fetchData()
    } catch (err) {
      alert(`Import failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
    setUploading(false)
    e.target.value = ''
  }

  const downloadTemplate = () => {
    const csv = 'email,name,status,list\njohn@example.com,John Doe,subscribed,My List\njane@example.com,Jane Smith,subscribed,'
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'contacts-template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const clearFilters = () => {
    setSearchEmail('')
    setSearchName('')
    setFilterStatus('')
    setFilterList('')
    setDateFrom('')
    setDateTo('')
  }

  const hasFilters = searchEmail || searchName || filterStatus || filterList || dateFrom || dateTo

  const filteredContacts = contacts.filter(c => {
    const matchesEmail = !searchEmail || c.email.toLowerCase().includes(searchEmail.toLowerCase())
    const matchesName = !searchName || (c.name && c.name.toLowerCase().includes(searchName.toLowerCase()))
    const matchesStatus = !filterStatus || c.status === filterStatus
    const matchesList = !filterList || c.list_id === filterList
    const contactDate = new Date(c.created_at)
    const matchesFrom = !dateFrom || contactDate >= new Date(dateFrom)
    const matchesTo = !dateTo || contactDate <= new Date(dateTo + 'T23:59:59')
    return matchesEmail && matchesName && matchesStatus && matchesList && matchesFrom && matchesTo
  })

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

      <div className="flex gap-2 mb-4 items-center">
        <label className="bg-green-600 text-white px-4 py-2 rounded cursor-pointer hover:bg-green-700">
          {uploading ? 'Uploading...' : 'Upload CSV'}
          <input type="file" accept=".csv" onChange={handleBulkUpload} className="hidden" disabled={uploading} />
        </label>
        <button onClick={downloadTemplate} className="text-blue-600 hover:underline text-sm">
          Download Template
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4 items-center">
        <input
          type="text"
          placeholder="Search email..."
          value={searchEmail}
          onChange={e => setSearchEmail(e.target.value)}
          className="border p-2 rounded text-sm w-40"
        />
        <input
          type="text"
          placeholder="Search name..."
          value={searchName}
          onChange={e => setSearchName(e.target.value)}
          className="border p-2 rounded text-sm w-32"
        />
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border p-2 rounded text-sm">
          <option value="">All Status</option>
          <option value="subscribed">Subscribed</option>
          <option value="unsubscribed">Unsubscribed</option>
          <option value="hardbounced">Hard Bounced</option>
        </select>
        <select value={filterList} onChange={e => setFilterList(e.target.value)} className="border p-2 rounded text-sm">
          <option value="">All Lists</option>
          {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="border p-2 rounded text-sm" />
        <span className="text-gray-500">to</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="border p-2 rounded text-sm" />
        {hasFilters && (
          <button onClick={clearFilters} className="text-red-600 hover:underline text-sm">Clear</button>
        )}
      </div>

      {loading ? <p>Loading...</p> : (
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
            {filteredContacts.map(c => (
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
            {filteredContacts.length === 0 && <tr><td colSpan={6} className="p-4 text-center">No contacts found</td></tr>}
          </tbody>
        </table>
      )}
    </div>
  )
}

interface EmailSend {
  id: string
  tracking_id: string
  recipient_email: string
  subject: string
  status: string
  sent_at: string | null
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
  const [sends, setSends] = useState<EmailSend[]>([])
  const [attachments, setAttachments] = useState<Record<string, Attachment[]>>({})
  const [events, setEvents] = useState<Record<string, EmailEvent[]>>({})
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [searchEmail, setSearchEmail] = useState('')
  const [searchFile, setSearchFile] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [tenantId, setTenantId] = useState<string | null>(null)

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true)
      const { data: membership } = await supabase.from('memberships').select('tenant_id').eq('user_id', session.user.id).single()
      if (!membership) { setLoading(false); return }
      setTenantId(membership.tenant_id)

      const { data } = await supabase.from('email_sends').select('*').eq('tenant_id', membership.tenant_id).order('created_at', { ascending: false }).limit(200)
      if (data) setSends(data as EmailSend[])
      
      const sendIds = data?.map(s => s.id) || []
      if (sendIds.length > 0) {
        const { data: atts } = await supabase.from('send_attachments').select('*').in('send_id', sendIds)
        if (atts) {
          const attMap: Record<string, Attachment[]> = {}
          atts.forEach((a: Attachment) => {
            if (!attMap[a.send_id]) attMap[a.send_id] = []
            attMap[a.send_id].push(a)
          })
          setAttachments(attMap)
        }
        
        const { data: evts } = await supabase.from('email_events').select('*').in('send_id', sendIds).order('created_at', { ascending: true })
        if (evts) {
          const evtMap: Record<string, EmailEvent[]> = {}
          evts.forEach((e: EmailEvent) => {
            if (!evtMap[e.send_id]) evtMap[e.send_id] = []
            evtMap[e.send_id].push(e)
          })
          setEvents(evtMap)
        }
      }
      setLoading(false)
    }
    fetchData()
  }, [session.user.id])

  const filteredSends = sends.filter(s => {
    const matchesEmail = !searchEmail || s.recipient_email.toLowerCase().includes(searchEmail.toLowerCase()) || s.subject.toLowerCase().includes(searchEmail.toLowerCase())
    const atts = attachments[s.id] || []
    const fileNames = atts.map(a => a.file_name).join(' ').toLowerCase()
    const matchesFile = !searchFile || fileNames.includes(searchFile.toLowerCase())
    const emailDate = new Date(s.created_at)
    const matchesFrom = !dateFrom || emailDate >= new Date(dateFrom)
    const matchesTo = !dateTo || emailDate <= new Date(dateTo + 'T23:59:59')
    return matchesEmail && matchesFile && matchesFrom && matchesTo
  })

  const hasFilters = searchEmail || searchFile || dateFrom || dateTo

  const clearFilters = () => {
    setSearchEmail('')
    setSearchFile('')
    setDateFrom('')
    setDateTo('')
  }

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id)
  }

  const downloadCSV = () => {
    const dataToExport = hasFilters ? filteredSends : sends
    const headers = ['Date', 'Recipient', 'Subject', 'Status', 'Attachments', 'Opens', 'Clicks', 'First Open', 'First Click', 'All Events']
    const rows = dataToExport.map(s => {
      const atts = attachments[s.id] || []
      const evtList = events[s.id] || []
      const openEvents = evtList.filter(e => e.event_type === 'open')
      const clickEvents = evtList.filter(e => e.event_type === 'click')
      const firstOpen = openEvents.length > 0 ? openEvents[0].created_at : ''
      const firstClick = clickEvents.length > 0 ? clickEvents[0].created_at : ''
      const allEvents = evtList.map(e => `${e.event_type}:${e.created_at}${e.clicked_url ? ':' + e.clicked_url : ''}`).join('; ')
      const row = [
        s.created_at,
        s.recipient_email,
        s.subject,
        s.status,
        atts.map(a => a.file_name).join(', '),
        s.open_count || 0,
        s.click_count || 0,
        firstOpen,
        firstClick,
        allEvents
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
      return row
    })
    const csv = [headers.join(','), ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `email-history-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const deleteRecords = async () => {
    const dataToDelete = hasFilters ? filteredSends : sends
    if (dataToDelete.length === 0 || !tenantId) return

    const confirmMsg = hasFilters
      ? `Delete ${dataToDelete.length} filtered records? This cannot be undone.`
      : `Delete ALL ${dataToDelete.length} history records? This cannot be undone.`

    if (!confirm(confirmMsg)) return

    const sendIds = dataToDelete.map(s => s.id)

    const deleteEvents = await supabase.from('email_events').delete().in('send_id', sendIds)
    const deleteAttachments = await supabase.from('send_attachments').delete().in('send_id', sendIds)
    const deleteSends = await supabase.from('email_sends').delete().in('id', sendIds).eq('tenant_id', tenantId)

    if (deleteEvents.error) {
      console.error('Failed to delete events:', deleteEvents.error)
      alert(`Failed to delete events: ${deleteEvents.error.message}`)
      return
    }
    if (deleteAttachments.error) {
      console.error('Failed to delete attachments:', deleteAttachments.error)
      alert(`Failed to delete attachments: ${deleteAttachments.error.message}`)
      return
    }
    if (deleteSends.error) {
      console.error('Failed to delete sends:', deleteSends.error)
      alert(`Failed to delete sends: ${deleteSends.error.message}`)
      return
    }

    setSends(sends.filter(s => !sendIds.includes(s.id)))
    const newAttachments: Record<string, Attachment[]> = {}
    Object.keys(attachments).forEach(key => {
      if (!sendIds.includes(key)) newAttachments[key] = attachments[key]
    })
    setAttachments(newAttachments)
    const newEvents: Record<string, EmailEvent[]> = {}
    Object.keys(events).forEach(key => {
      if (!sendIds.includes(key)) newEvents[key] = events[key]
    })
    setEvents(newEvents)
  }

  return (
    <div className="bg-white p-6 rounded shadow">
      <div className="flex flex-wrap gap-4 mb-4 items-center">
        <h2 className="text-lg font-bold mr-auto">Sent Emails</h2>
        <input
          type="text"
          placeholder="Search email or subject..."
          value={searchEmail}
          onChange={e => setSearchEmail(e.target.value)}
          className="border p-2 rounded text-sm w-48"
        />
        <input
          type="text"
          placeholder="Search file name..."
          value={searchFile}
          onChange={e => setSearchFile(e.target.value)}
          className="border p-2 rounded text-sm w-40"
        />
        <input
          type="date"
          value={dateFrom}
          onChange={e => setDateFrom(e.target.value)}
          className="border p-2 rounded text-sm"
        />
        <span className="text-gray-500">to</span>
        <input
          type="date"
          value={dateTo}
          onChange={e => setDateTo(e.target.value)}
          className="border p-2 rounded text-sm"
        />
        {hasFilters && (
          <button onClick={clearFilters} className="text-red-600 hover:underline text-sm px-2">
            Clear Filters
          </button>
        )}
        <button onClick={downloadCSV} className="bg-green-600 text-white px-4 py-2 rounded text-sm hover:bg-green-700">
          {hasFilters ? `Download CSV (${filteredSends.length})` : 'Download CSV'}
        </button>
        <button onClick={deleteRecords} className="bg-red-600 text-white px-4 py-2 rounded text-sm hover:bg-red-700">
          {hasFilters ? `Delete (${filteredSends.length})` : 'Delete All'}
        </button>
      </div>
      {loading ? <p>Loading...</p> : (
        <div className="space-y-2">
          {filteredSends.map(s => {
            const atts = attachments[s.id] || []
            const evtList = events[s.id] || []
            const isExpanded = expandedId === s.id
            return (
            <div key={s.id} className="border rounded">
              <div onClick={() => toggleExpand(s.id)} className="p-3 cursor-pointer hover:bg-gray-50 flex items-center justify-between">
                <div className="flex-1 grid grid-cols-7 gap-2 text-sm">
                  <div className="text-gray-500">{new Date(s.created_at).toLocaleDateString()}</div>
                  <div className="truncate">{s.recipient_email}</div>
                  <div className="truncate">{s.subject}</div>
                  <div className="truncate text-xs text-gray-500">{atts.map(a => a.file_name).join(', ') || '-'}</div>
                  <div>
                    <span className={`px-2 py-1 rounded-full text-xs ${
                      s.status === 'sent' ? 'bg-green-100 text-green-800' : 
                      s.status === 'failed' ? 'bg-red-100 text-red-800' : 'bg-yellow-100 text-yellow-800'
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
                  <div className="mb-2">
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
                  <div>
                    <span className="font-medium">📊 Activity Timeline:</span>
                    {evtList.length > 0 ? (
                      <div className="mt-2 space-y-1">
                        {evtList.map((e, i) => (
                          <div key={i} className={`flex items-center gap-2 text-xs ${e.event_type === 'open' ? 'text-blue-600' : 'text-purple-600'}`}>
                            <span>{e.event_type === 'open' ? '👁 Opened' : '🔗 Clicked'}</span>
                            {e.clicked_url && <span className="text-blue-600 hover:underline" title={e.clicked_url}>{new URL(e.clicked_url).hostname}</span>}
                            <span className="text-gray-400">• {new Date(e.created_at).toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    ) : <span className="text-gray-400 ml-2">No opens or clicks recorded yet</span>}
                  </div>
                </div>
              )}
            </div>
          )})}
          {sends.length === 0 && <p className="text-center text-gray-400 py-4">No emails sent yet</p>}
        </div>
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
  const [uploading, setUploading] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [tenantId, setTenantId] = useState<string | null>(null)

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
    const { data, error } = await supabase.storage.from(BUCKET_NAME).list(tenantId, { limit: 100 })
    if (error) {
      console.error('Error fetching files:', error)
    } else if (data) {
      setFiles(data.map(f => ({
        name: f.name,
        id: f.id,
        updated_at: f.updated_at || '',
        size: f.metadata?.size || 0,
        metadata: f.metadata || {}
      })))
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
      alert(`Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
    setUploading(false)
  }

  const handleDelete = async (path: string) => {
    if (!confirm('Delete this file?')) return
    const { error } = await supabase.storage.from(BUCKET_NAME).remove([path])
    if (error) {
      alert(`Delete failed: ${error.message}`)
    } else {
      fetchFiles()
    }
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
    search === '' || f.name.toLowerCase().includes(search.toLowerCase())
  )

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
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredFiles.map((file) => {
            const fullPath = `${session.user.id}/${file.name}`
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
          {filteredFiles.length === 0 && (
            <p className="col-span-full text-center text-gray-400 py-8">
              {search ? 'No files match your search' : 'No files uploaded yet'}
            </p>
          )}
        </div>
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
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  const fetchLists = async () => {
    setLoading(true)
    const { data: membership } = await supabase.from('memberships').select('tenant_id').eq('user_id', session.user.id).single()
    if (!membership) { setLoading(false); return }

    const { data: listData } = await supabase
      .from('lists')
      .select('*')
      .eq('tenant_id', membership.tenant_id)
      .order('name')

    if (listData) {
      const listsWithCounts = await Promise.all(listData.map(async (list) => {
        const { count } = await supabase
          .from('contacts')
          .select('*', { count: 'exact', head: true })
          .eq('tenant_id', membership.tenant_id)
          .eq('list_id', list.id)
        return { ...list, subscriber_count: count || 0 }
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

    await supabase.from('lists').insert({ tenant_id: membership.tenant_id, name: newListName.trim() })
    setNewListName('')
    setShowAddForm(false)
    fetchLists()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this list? Contacts will be unlinked but not deleted.')) return
    await supabase.from('lists').delete().eq('id', id)
    fetchLists()
  }

  const startEdit = (list: ListWithCount) => {
    setEditingId(list.id)
    setEditName(list.name)
  }

  const saveEdit = async () => {
    if (!editingId || !editName.trim()) return
    await supabase.from('lists').update({ name: editName.trim() }).eq('id', editingId)
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
    !search || l.name.toLowerCase().includes(search.toLowerCase())
  )

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
            {filteredLists.map(list => (
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
            {filteredLists.length === 0 && (
              <tr><td colSpan={4} className="p-4 text-center text-gray-400">{search ? 'No lists match your search' : 'No lists yet'}</td></tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  )
}

function SettingsTab({ session }: { session: Session }) {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [tenantId, setTenantId] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!session?.user?.id) return
    supabase.from('memberships').select('ms_access_token, ms_refresh_token, tenant_id')
      .eq('user_id', session.user.id).single()
      .then(({ data }) => {
        if (data?.ms_access_token) setAccessToken(data.ms_access_token)
        if (data?.ms_refresh_token) setRefreshToken(data.ms_refresh_token)
        if (data?.tenant_id) {
          supabase.from('tenants').select('ms_client_id, ms_client_secret, ms_tenant_id')
            .eq('id', data.tenant_id).single()
            .then(({ data: tenant }) => {
              if (tenant?.ms_client_id) setClientId(tenant.ms_client_id)
              if (tenant?.ms_client_secret) setClientSecret(tenant.ms_client_secret)
              if (tenant?.ms_tenant_id) setTenantId(tenant.ms_tenant_id)
            })
        }
      })
  }, [session?.user?.id])

  const saveCredentials = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setStatus('Saving...')
    
    if (!session?.user?.id) {
      setStatus('Error: No session')
      setLoading(false)
      return
    }

    const { data: membership } = await supabase.from('memberships').select('tenant_id').eq('user_id', session.user.id).single()
    if (!membership) {
      setStatus('Error: No tenant found')
      setLoading(false)
      return
    }

    const { error: tenantErr } = await supabase.from('tenants').update({
      ms_client_id: clientId,
      ms_client_secret: clientSecret,
      ms_tenant_id: tenantId
    }).eq('id', membership.tenant_id)

    const { error: memberErr } = await supabase.from('memberships').update({
      ms_refresh_token: refreshToken,
      ms_access_token: accessToken
    }).eq('user_id', session.user.id)

    if (tenantErr || memberErr) {
      setStatus(`Error: ${tenantErr?.message || memberErr?.message}`)
    } else {
      setStatus('Saved!')
    }
    setLoading(false)
  }

  const testConnection = async () => {
    if (!accessToken) {
      setStatus('No access token to test')
      return
    }
    setLoading(true)
    setStatus('Testing...')
    try {
      const res = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { 'Authorization': 'Bearer ' + accessToken }
      })
      if (res.ok) {
        setStatus('✅ Connection successful!')
      } else {
        await res.text()
        setStatus(`❌ Failed: ${res.status}`)
      }
    } catch (err) {
      setStatus(`❌ Error: ${err}`)
    }
    setLoading(false)
  }

  return (
    <div className="bg-white p-6 rounded shadow max-w-lg">
      <h2 className="text-lg font-bold mb-4">Microsoft Graph Settings</h2>
      <form onSubmit={saveCredentials} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Client ID (App ID)</label>
          <input type="text" value={clientId} onChange={e => setClientId(e.target.value)} 
            className="w-full border p-2 rounded text-sm" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Client Secret</label>
          <input type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} 
            className="w-full border p-2 rounded text-sm" placeholder="Your client secret" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Tenant ID</label>
          <input type="text" value={tenantId} onChange={e => setTenantId(e.target.value)} 
            className="w-full border p-2 rounded text-sm" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Refresh Token</label>
          <textarea value={refreshToken} onChange={e => setRefreshToken(e.target.value)} 
            rows={3} className="w-full border p-2 rounded text-sm font-mono" placeholder="Paste refresh token..." />
          <p className="text-xs text-gray-500 mt-1">Used to auto-refresh access token</p>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Access Token</label>
          <textarea value={accessToken} onChange={e => setAccessToken(e.target.value)} 
            rows={3} className="w-full border p-2 rounded text-sm font-mono" placeholder="Paste access token..." />
        </div>
        <div className="flex gap-2">
          <button type="submit" disabled={loading} className="flex-1 bg-gray-800 text-white py-2 rounded">
            {loading ? 'Saving...' : 'Save All'}
          </button>
          <button type="button" onClick={testConnection} disabled={loading || !accessToken} 
            className="bg-green-600 text-white py-2 px-4 rounded disabled:opacity-50">
            Test
          </button>
        </div>
      </form>
      {status && (
        <div className={`mt-4 p-2 rounded text-sm ${status.includes('❌') ? 'bg-red-100 text-red-700' : status.includes('✅') ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
          {status}
        </div>
      )}
      <div className="mt-6 p-4 bg-blue-50 rounded text-sm">
        <h3 className="font-medium mb-2">How to get credentials:</h3>
        <ol className="list-decimal list-inside space-y-1 text-gray-600">
          <li>Go to <a href="https://portal.azure.com" target="_blank" className="text-blue-600 underline">Azure Portal</a></li>
          <li>Register an app or use existing</li>
          <li>Copy App (client) ID and Directory (tenant) ID</li>
          <li>Create a client secret in "Certificates & secrets"</li>
          <li>For refresh token: Use Graph Explorer → Sign in → Copy token</li>
        </ol>
      </div>
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
      .eq('tenant_id', membership.tenant_id)
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
          tenant_id: invitation.tenant_id,
          user_id: user.id,
          role: invitation.role
        })

      if (approveError) {
        if (approveError.message.includes('duplicate')) {
          throw new Error('User is already a member')
        }
        throw approveError
      }

      await supabase
        .from('invitations')
        .update({ status: 'approved' })
        .eq('id', invitation.id)

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
        await supabase
          .from('memberships')
          .delete()
          .eq('user_id', userData.id)
          .eq('tenant_id', invitation.tenant_id)

        // Delete from public.users
        await supabase
          .from('users')
          .delete()
          .eq('id', userData.id)
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