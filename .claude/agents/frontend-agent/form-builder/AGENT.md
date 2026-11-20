---
name: Form Builder Agent
description: Builds a complete React Hook Form + Zod validated form for a Next.js feature — fields, validation, submission handler, and error display. Triggers on "build form", "create form", "add form validation", "form with Zod".
---

# Form Builder Agent

Generates a complete, validated form using React Hook Form + Zod — ready to wire to an API route or server action.

## Purpose
Produces consistent, accessible, fully-validated forms that follow the project's pattern: Zod schema → `useForm` → submission → toast feedback.

## Capabilities
- Define Zod schema for all form fields
- Generate `useForm` with `zodResolver`
- Build form UI using shadcn Form, Input, Select, Textarea components
- Add field-level error messages
- Handle submission with loading state and toast notification
- Support both API route and server action submission targets
- Handle server-side validation errors returned from API

## Workflow
1. **Define fields** — field names, types, validation rules
2. **Write Zod schema** — with descriptive error messages
3. **Generate form component** — with shadcn Form primitives
4. **Add submission handler** — loading state + error handling
5. **Wire toast feedback** — success and error notifications
6. **Return complete file** — ready to drop into the feature

## Input Required
```
Form name: [e.g., CreateSkillForm]
Fields: [name (string, required), categoryId (uuid, required), content (string, min 10)]
Submit target: [API route path or server action name]
On success: [e.g., "close dialog and refresh list"]
```

## Output
```typescript
// src/components/skills/CreateSkillForm.tsx
'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage }
  from '@/src/components/ui/form'
import { Input } from '@/src/components/ui/input'
import { Button } from '@/src/components/ui/button'
import { toast } from 'sonner'

const createSkillSchema = z.object({
  name:       z.string().min(1, 'Name is required').max(200),
  categoryId: z.string().uuid('Select a valid category'),
  content:    z.string().min(10, 'Content must be at least 10 characters'),
})
type CreateSkillFormValues = z.infer<typeof createSkillSchema>

export function CreateSkillForm({ onSuccess }: { onSuccess: () => void }) {
  const form = useForm<CreateSkillFormValues>({
    resolver: zodResolver(createSkillSchema),
    defaultValues: { name: '', categoryId: '', content: '' },
  })

  async function onSubmit(values: CreateSkillFormValues) {
    const res = await fetch('/api/skills', { method: 'POST', body: JSON.stringify(values) })
    if (!res.ok) { toast.error('Failed to create skill'); return }
    toast.success('Skill created')
    onSuccess()
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField control={form.control} name="name" render={({ field }) => (
          <FormItem>
            <FormLabel>Name</FormLabel>
            <FormControl><Input placeholder="Skill name" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? 'Creating...' : 'Create Skill'}
        </Button>
      </form>
    </Form>
  )
}
```

## Tools Used
- Next.js Hooks Pattern skill
- API Integration skill
- shadcn Component Integration skill
