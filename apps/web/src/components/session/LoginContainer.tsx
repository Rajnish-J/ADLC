'use client'

// The sign-in page, in login-03's layout: a centred column on a muted background with the brand above the card.
// Which card depends on the server's AUTH_MODE: "Sign in with Microsoft" (Entra ID), or the local-development
// picker of seeded users.

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Workflow } from 'lucide-react'
import * as UI from '@/imports/UI.imports'
import * as S from '@/imports/session.imports'
import { LoginForm } from './login-form'
import { MicrosoftLoginForm } from './microsoft-login-form'

function DevSignIn({ returnTo }: { returnTo: string }) {
  const router = useRouter()
  const [users, setUsers] = useState<S.User[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    S.getDevUsers()
      .then(setUsers)
      .catch((err) => setError(err instanceof S.AppError ? err.message : 'Could not load users'))
  }, [])

  async function choose(email: string): Promise<void> {
    setBusy(email)
    try {
      await S.signIn(email)
      router.replace(returnTo)
    } catch (err) {
      UI.toast.error(err instanceof S.AppError ? err.message : 'Sign-in failed')
      setBusy(null)
    }
  }

  return (
    <>
      {error ? <UI.ErrorAlert title="Cannot reach the platform" message={error} /> : null}
      <LoginForm users={error ? [] : users} busyEmail={busy} onChoose={(email) => void choose(email)} />
    </>
  )
}

function MicrosoftSignIn({ returnTo }: { returnTo: string }) {
  const params = useSearchParams()
  const [redirecting, setRedirecting] = useState(false)
  const error = S.SignInErrorSchema.safeParse(params.get('error'))

  function signIn(): void {
    setRedirecting(true)
    S.startMicrosoftSignIn(returnTo)
  }

  return <MicrosoftLoginForm error={error.success ? error.data : null} redirecting={redirecting} onSignIn={signIn} />
}

/** Only a path inside this app — never another origin (`//host`, `https://…`). The server checks it again. */
function safeReturnTo(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/'
}

function SignInCard() {
  const params = useSearchParams()
  const returnTo = safeReturnTo(params.get('returnTo'))
  const [mode, setMode] = useState<S.AuthMode | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    S.getAuthInfo()
      .then((info) => setMode(info.mode))
      .catch((err) => setError(err instanceof S.AppError ? err.message : 'Could not load sign-in options'))
  }, [])

  if (error) return <UI.ErrorAlert title="Cannot reach the platform" message={error} />
  if (mode === 'entra') return <MicrosoftSignIn returnTo={returnTo} />
  if (mode === 'dev') return <DevSignIn returnTo={returnTo} />
  return <UI.Skeleton className="h-72 rounded-xl" />
}

export default function LoginContainer() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-md flex-col gap-6">
        <div className="flex items-center gap-2 self-center font-medium">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Workflow className="size-4" />
          </div>
          SDLC Platform
        </div>
        <Suspense fallback={<UI.Skeleton className="h-72 rounded-xl" />}>
          <SignInCard />
        </Suspense>
      </div>
    </div>
  )
}
