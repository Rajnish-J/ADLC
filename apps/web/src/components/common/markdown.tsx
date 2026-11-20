'use client'

// Renders markdown (agent definitions, and later repo-discovered agents and skills) as HTML. Raw HTML in the
// source is NOT rendered (`html: false` escapes it) and markdown-it refuses javascript:/data: links, so content
// from a repository can't inject script. Styled by the `.markdown` rules in globals.css.

import { useMemo } from 'react'
import MarkdownIt from 'markdown-it'
import { cn } from '@/lib/utils'

const md = new MarkdownIt({ html: false, linkify: true, typographer: true })

// Open links in a new tab, without giving the target page a handle on this one.
const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank')
  tokens[idx].attrSet('rel', 'noopener noreferrer')
  return defaultLinkOpen(tokens, idx, options, env, self)
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => md.render(source), [source])
  return <div className={cn('markdown', className)} dangerouslySetInnerHTML={{ __html: html }} />
}
