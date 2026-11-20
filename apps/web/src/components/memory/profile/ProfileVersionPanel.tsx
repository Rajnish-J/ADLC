'use client'

// One version of the project profile in full — opened from its row in the memory table: headline, stack chips and
// the sections (tabs, scrolling inside a fixed height), with edit (current version, leads), all versions and download.

import { Download, History, Pencil } from 'lucide-react'
import { useProfileVersion, useProfileVersions } from '@/hooks/memory/useProjectProfile'
import * as UI from '@/imports/UI.imports'
import { profileDownloadUrl } from '@/service/profile.service'
import ProfileEditSheet from './ProfileEditSheet'
import ProfileHistorySheet from './ProfileHistorySheet'
import ProfileView, { MATURITY_META, StackChips } from './ProfileView'

export default function ProfileVersionPanel({ projectKey, version }: { projectKey: string; version: number }) {
  const versions = useProfileVersions(projectKey, true)
  const id = versions.data?.find((v) => v.version === version)?.id ?? null
  const profile = useProfileVersion(projectKey, id)
  const p = profile.data

  if (versions.error || profile.error) return <UI.ErrorAlert message={(versions.error ?? profile.error)?.message ?? 'Could not load the profile.'} />
  if (!p?.content) return <UI.Skeleton className="h-96" />
  const maturity = MATURITY_META[p.content.maturity]

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <UI.Badge variant={maturity.variant}>{maturity.label}</UI.Badge>
          {!p.aiWritten ? <UI.Badge variant="outline">Counted facts only</UI.Badge> : null}
          <span className="text-xs text-muted-foreground">
            {p.branch ? (
              <span className="font-mono">
                {p.branch}
                {p.commitSha ? ` @ ${p.commitSha.slice(0, 7)}` : ''}
              </span>
            ) : null}
            {p.model ? ` · ${p.model}` : ''}
          </span>
          <div className="ml-auto flex gap-1">
            {p.actions.canEdit ? (
              <ProfileEditSheet
                projectKey={projectKey}
                profile={p}
                trigger={
                  <UI.Button size="sm" variant="ghost">
                    <Pencil /> Edit
                  </UI.Button>
                }
              />
            ) : null}
            <ProfileHistorySheet
              projectKey={projectKey}
              initialVersion={version}
              trigger={
                <UI.Button size="sm" variant="ghost">
                  <History /> Versions
                </UI.Button>
              }
            />
            <UI.Button size="sm" variant="ghost" asChild>
              <a href={profileDownloadUrl(projectKey, p.id)}>
                <Download /> .md
              </a>
            </UI.Button>
          </div>
        </div>
        <p className="text-sm">{p.content.headline}</p>
        <StackChips content={p.content} />
      </div>
      <ProfileView content={p.content} projectKey={projectKey} branch={p.branch} className="min-h-0 flex-1" panelClassName="min-h-0 overflow-y-auto pr-2" />
    </div>
  )
}
