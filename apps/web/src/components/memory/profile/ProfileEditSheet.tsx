'use client'

// A lead edits the profile's text — the accepted one, or a proposed update before accepting it ("Edit & accept").

import { useEffect, useState, type ReactNode } from 'react'
import { PROFILE_MATURITIES, PROFILE_SECTION_KEYS, PROFILE_SECTION_LABELS, type ProfileMaturity, type ProfileSectionKey, type ProjectProfile } from '@sdlc/contracts'
import { AppError } from '@/appError'
import * as UI from '@/imports/UI.imports'
import { decideProjectProfile, updateProjectProfile } from '@/service/profile.service'
import { MATURITY_META } from './ProfileView'

interface Props {
  projectKey: string
  profile: ProjectProfile
  /** Accept the proposal after saving the edits. */
  acceptAfter?: boolean
  trigger: ReactNode
}

export default function ProfileEditSheet({ projectKey, profile, acceptAfter, trigger }: Props) {
  const [open, setOpen] = useState(false)
  const [headline, setHeadline] = useState('')
  const [maturity, setMaturity] = useState<ProfileMaturity>('active')
  const [sections, setSections] = useState<Record<ProfileSectionKey, string>>({} as Record<ProfileSectionKey, string>)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !profile.content) return
    setHeadline(profile.content.headline)
    setMaturity(profile.content.maturity)
    setSections(Object.fromEntries(PROFILE_SECTION_KEYS.map((k) => [k, profile.content?.sections[k].markdown ?? ''])) as Record<ProfileSectionKey, string>)
    setError(null)
  }, [open, profile])

  async function save(): Promise<void> {
    if (!profile.content) return
    setSaving(true)
    setError(null)
    try {
      const changed = PROFILE_SECTION_KEYS.filter((k) => sections[k] !== profile.content?.sections[k].markdown)
      await updateProjectProfile(projectKey, profile.id, {
        headline: headline.trim() || undefined,
        maturity,
        sections: Object.fromEntries(changed.map((k) => [k, { markdown: sections[k] }])),
      })
      if (acceptAfter) await decideProjectProfile(projectKey, profile.id, { decision: 'accept', comment: 'Edited and accepted.' })
      UI.toast.success(acceptAfter ? 'Profile update accepted' : 'Profile saved')
      setOpen(false)
    } catch (err) {
      setError(err instanceof AppError ? err.message : 'Could not save the profile.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <UI.Sheet open={open} onOpenChange={setOpen}>
      <UI.SheetTrigger asChild>{trigger}</UI.SheetTrigger>
      <UI.SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        <UI.SheetHeader className="border-b">
          <UI.SheetTitle>{acceptAfter ? `Edit & accept profile v${profile.version}` : `Edit project profile v${profile.version}`}</UI.SheetTitle>
          <UI.SheetDescription>Markdown. Agents get the edited text from the next run on.</UI.SheetDescription>
        </UI.SheetHeader>
        <div className="flex-1 overflow-y-auto p-4">
          <UI.FieldGroup>
            <UI.Field>
              <UI.FieldLabel htmlFor="profile-headline">Headline</UI.FieldLabel>
              <UI.Input id="profile-headline" value={headline} maxLength={400} onChange={(e) => setHeadline(e.target.value)} />
            </UI.Field>
            <UI.Field>
              <UI.FieldLabel>Maturity</UI.FieldLabel>
              <UI.ToggleGroup type="single" variant="outline" size="sm" value={maturity} onValueChange={(v) => v && setMaturity(v as ProfileMaturity)} className="flex-wrap">
                {PROFILE_MATURITIES.map((m) => (
                  <UI.ToggleGroupItem key={m} value={m} className="px-3">
                    {MATURITY_META[m].label}
                  </UI.ToggleGroupItem>
                ))}
              </UI.ToggleGroup>
            </UI.Field>
            {PROFILE_SECTION_KEYS.map((k) => (
              <UI.Field key={k}>
                <UI.FieldLabel htmlFor={`profile-${k}`}>{PROFILE_SECTION_LABELS[k]}</UI.FieldLabel>
                <UI.Textarea id={`profile-${k}`} value={sections[k] ?? ''} rows={7} maxLength={12_000} className="font-mono text-xs" onChange={(e) => setSections((s) => ({ ...s, [k]: e.target.value }))} />
              </UI.Field>
            ))}
            {error ? <UI.FieldError>{error}</UI.FieldError> : null}
          </UI.FieldGroup>
        </div>
        <div className="flex justify-end gap-2 border-t p-4">
          <UI.Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </UI.Button>
          <UI.Button onClick={() => void save()} disabled={saving}>
            {saving ? <UI.Spinner /> : null} {acceptAfter ? 'Save & accept' : 'Save'}
          </UI.Button>
        </div>
      </UI.SheetContent>
    </UI.Sheet>
  )
}
