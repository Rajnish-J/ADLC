'use client'

// login-03's card, for Microsoft Entra ID sign-in: one "Sign in with Microsoft" button, why a previous attempt
// failed (when it did), and what signing in means for someone new to the platform.

import { AlertCircle, Building2, KeyRound, ShieldCheck } from 'lucide-react'
import type { SignInError } from '@/types/session/session.types'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldSeparator } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { MicrosoftLogo } from './microsoft-logo'

const ERROR_TEXT: Record<SignInError, { title: string; message: string }> = {
  cancelled: {
    title: 'Sign-in cancelled',
    message: 'You closed or declined the Microsoft sign-in. Try again when you are ready.',
  },
  expired_request: {
    title: 'Sign-in timed out',
    message: 'The sign-in request expired or was opened in another browser. Start again from here.',
  },
  signin_failed: {
    title: 'Sign-in failed',
    message: 'Microsoft could not complete the sign-in. Try again, or contact your administrator if it keeps happening.',
  },
  not_configured: {
    title: 'Microsoft sign-in is not set up',
    message: 'The server is missing its Entra ID configuration. Ask an administrator to check the ENTRA_* settings.',
  },
}

const HIGHLIGHTS = [
  { icon: Building2, text: 'Use your organization work account' },
  { icon: KeyRound, text: 'No separate password to remember' },
  { icon: ShieldCheck, text: 'Protected by your organization’s sign-in policies' },
]

interface MicrosoftLoginFormProps {
  error: SignInError | null
  redirecting: boolean
  onSignIn: () => void
  className?: string
}

export function MicrosoftLoginForm({ error, redirecting, onSignIn, className }: MicrosoftLoginFormProps) {
  const errorText = error ? ERROR_TEXT[error] : null
  return (
    <div className={cn('flex flex-col gap-6', className)}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Welcome back</CardTitle>
          <CardDescription>Sign in with your Microsoft work account to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            {errorText ? (
              <Alert variant="destructive" role="alert">
                <AlertCircle />
                <AlertTitle>{errorText.title}</AlertTitle>
                <AlertDescription>{errorText.message}</AlertDescription>
              </Alert>
            ) : null}
            <Field>
              <Button type="button" variant="outline" size="lg" className="w-full" disabled={redirecting} onClick={onSignIn}>
                {redirecting ? <Spinner /> : <MicrosoftLogo />}
                {redirecting ? 'Redirecting to Microsoft…' : 'Sign in with Microsoft'}
              </Button>
            </Field>
            <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">Single sign-on</FieldSeparator>
            <ul className="flex flex-col gap-2.5 text-sm text-muted-foreground">
              {HIGHLIGHTS.map(({ icon: Icon, text }) => (
                <li key={text} className="flex items-center gap-2.5">
                  <Icon className="size-4 shrink-0 text-foreground/70" aria-hidden="true" />
                  {text}
                </li>
              ))}
            </ul>
          </FieldGroup>
        </CardContent>
      </Card>
      <FieldDescription className="px-6 text-center">
        First time here? Signing in creates your account. A project owner then adds you to the projects you work on.
      </FieldDescription>
    </div>
  )
}
