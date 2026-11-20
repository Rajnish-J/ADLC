'use client'

// A story's tasks — like GitHub issues or Azure Boards Tasks under a user story. Each can be started on its own in
// your VS Code harness; its latest run shows beside it. Whoever may edit the story may add, edit and remove tasks.

import { useState } from 'react'
import { ExternalLink, ListTodo, Play, Plus, Trash2 } from 'lucide-react'
import {
  TASK_EXTERNAL_PROVIDER_LABELS,
  TASK_EXTERNAL_PROVIDERS,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  type ProjectDetail,
  type Story,
  type StoryTask,
  type TaskExternalProvider,
  type TaskStatus,
} from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { AppError } from '@/appError'
import { LatestRunChip } from '@/components/work/LatestRunChip'
import { useRunComposer } from '@/components/work/RunComposerProvider'
import { useStoryTasks } from '@/hooks/work/useHarnessRuns'
import { createTask, deleteTask, updateTask } from '@/service/harnessRun.service'

const fail = (err: unknown, fallback: string) => UI.toast.error(err instanceof AppError ? err.message : fallback)

function AddTask({ project, story, onDone }: { project: ProjectDetail; story: Story; onDone: () => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [provider, setProvider] = useState<TaskExternalProvider | 'none'>('none')
  const [externalId, setExternalId] = useState('')
  const [url, setUrl] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit() {
    setSaving(true)
    try {
      await createTask(project.key, story.number, {
        title,
        description,
        external: provider === 'none' ? null : { provider, externalId, url },
      })
      onDone()
    } catch (err) {
      fail(err, 'Could not add the task')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <UI.Input autoFocus placeholder="What needs to be done?" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      <UI.Textarea placeholder="Details (optional)" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      <div className="grid gap-2 sm:grid-cols-[11rem_7rem_minmax(0,1fr)]">
        <UI.Select value={provider} onValueChange={(v) => setProvider(v as TaskExternalProvider | 'none')}>
          <UI.SelectTrigger aria-label="Linked work item">
            <UI.SelectValue />
          </UI.SelectTrigger>
          <UI.SelectContent>
            <UI.SelectItem value="none">Not linked</UI.SelectItem>
            {TASK_EXTERNAL_PROVIDERS.map((p) => (
              <UI.SelectItem key={p} value={p}>
                {TASK_EXTERNAL_PROVIDER_LABELS[p]}
              </UI.SelectItem>
            ))}
          </UI.SelectContent>
        </UI.Select>
        {provider !== 'none' ? (
          <>
            <UI.Input placeholder={provider === 'github' ? '#123' : 'ID'} value={externalId} onChange={(e) => setExternalId(e.target.value)} />
            <UI.Input placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} type="url" />
          </>
        ) : null}
      </div>
      <div className="flex justify-end gap-2">
        <UI.Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </UI.Button>
        <UI.Button type="submit" size="sm" disabled={!title.trim() || saving || (provider !== 'none' && (!externalId.trim() || !url.trim()))}>
          {saving ? <UI.Spinner /> : null} Add task
        </UI.Button>
      </div>
    </form>
  )
}

function TaskRow({ project, story, task, canEdit, canStart }: { project: ProjectDetail; story: Story; task: StoryTask; canEdit: boolean; canStart: boolean }) {
  const [busy, setBusy] = useState(false)
  const { openComposer } = useRunComposer()
  async function setStatus(status: TaskStatus) {
    setBusy(true)
    try {
      await updateTask(project.key, story.number, task.number, { version: task.version, status })
    } catch (err) {
      fail(err, 'Could not update the task')
    } finally {
      setBusy(false)
    }
  }
  async function remove() {
    setBusy(true)
    try {
      await deleteTask(project.key, story.number, task.number)
    } catch (err) {
      fail(err, 'Could not delete the task')
      setBusy(false)
    }
  }
  const run = task.latestRun
  return (
    <UI.Item size="sm" className="rounded-none border-0 px-0">
      <UI.ItemContent>
        <UI.ItemTitle className={UI.cn(task.status === 'done' && 'text-muted-foreground line-through')}>
          <span className="font-mono text-xs text-muted-foreground">T{task.number}</span> {task.title}
        </UI.ItemTitle>
        <UI.ItemDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {task.external ? (
            <a href={task.external.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
              {TASK_EXTERNAL_PROVIDER_LABELS[task.external.provider]} {task.external.externalId} <ExternalLink className="size-3" />
            </a>
          ) : null}
          <LatestRunChip projectKey={project.key} run={run} />
          {task.description ? <span className="line-clamp-1">{task.description}</span> : null}
        </UI.ItemDescription>
      </UI.ItemContent>
      <UI.ItemActions>
        {canEdit ? (
          <UI.Select value={task.status} onValueChange={(v) => void setStatus(v as TaskStatus)} disabled={busy}>
            <UI.SelectTrigger size="sm" className="w-32" aria-label={`Status of T${task.number}`}>
              <UI.SelectValue />
            </UI.SelectTrigger>
            <UI.SelectContent>
              {TASK_STATUSES.map((s) => (
                <UI.SelectItem key={s} value={s}>
                  {TASK_STATUS_LABELS[s]}
                </UI.SelectItem>
              ))}
            </UI.SelectContent>
          </UI.Select>
        ) : (
          <UI.Badge variant="outline">{TASK_STATUS_LABELS[task.status]}</UI.Badge>
        )}
        {canStart && task.status !== 'done' ? (
          <UI.Button
            size="sm"
            variant="outline"
            aria-label={`Start T${task.number} in VS Code`}
            onClick={() => openComposer({ projectKey: project.key, storyNumber: story.number, taskNumber: task.number })}
          >
            <Play /> Start
          </UI.Button>
        ) : null}
        {canEdit ? (
          <UI.Button size="icon-sm" variant="ghost" onClick={() => void remove()} disabled={busy} aria-label={`Delete T${task.number}`}>
            <Trash2 />
          </UI.Button>
        ) : null}
      </UI.ItemActions>
    </UI.Item>
  )
}

export default function StoryTasks({ project, story }: { project: ProjectDetail; story: Story }) {
  const { data: tasks, error, loading } = useStoryTasks(project.key, story.number)
  const [adding, setAdding] = useState(false)
  const canEdit = story.actions.canEdit
  const canStart = story.actions.canReportWork
  const { openComposer } = useRunComposer()
  const done = (tasks ?? []).filter((t) => t.status === 'done').length

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">Tasks</h2>
        {tasks?.length ? (
          <span className="text-xs text-muted-foreground">
            {done}/{tasks.length} done
          </span>
        ) : null}
        <span className="ml-auto flex gap-2">
          {canStart ? (
            <UI.Button size="sm" variant="outline" onClick={() => openComposer({ projectKey: project.key, storyNumber: story.number })}>
              <Play /> Start story in VS Code
            </UI.Button>
          ) : null}
          {canEdit && !adding ? (
            <UI.Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
              <Plus /> Add task
            </UI.Button>
          ) : null}
        </span>
      </div>
      {error ? <UI.ErrorAlert message={error.message} /> : null}
      {loading && !tasks ? <UI.Skeleton className="h-16 rounded-lg" /> : null}
      {adding ? <AddTask project={project} story={story} onDone={() => setAdding(false)} /> : null}
      {tasks && tasks.length === 0 && !adding ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <ListTodo className="size-4" /> No tasks yet. Break the story into tasks — each one can run through the workflow on its own.
        </p>
      ) : null}
      {tasks?.length ? (
        <UI.ItemGroup className="divide-y">
          {tasks.map((t) => (
            <TaskRow key={t.id} project={project} story={story} task={t} canEdit={canEdit} canStart={canStart} />
          ))}
        </UI.ItemGroup>
      ) : null}
    </section>
  )
}
