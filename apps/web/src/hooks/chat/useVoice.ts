'use client'

// Browser-only voice: dictation through the Web Speech API (Chrome/Edge) and read-aloud through speechSynthesis.
// Nothing leaves the browser for these beyond what the browser's own speech service does; both are hidden where
// unsupported.

import { useCallback, useEffect, useRef, useState } from 'react'

interface RecognitionResultEvent {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}

interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  onresult: ((e: RecognitionResultEvent) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}

type RecognitionCtor = new () => Recognition

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** Dictation: `onText` receives each finished phrase. */
export function useDictation(onText: (text: string) => void) {
  const [supported, setSupported] = useState(false)
  const [listening, setListening] = useState(false)
  const recognition = useRef<Recognition | null>(null)
  const handler = useRef(onText)
  handler.current = onText

  useEffect(() => setSupported(recognitionCtor() !== null), [])

  const stop = useCallback(() => {
    recognition.current?.stop()
    setListening(false)
  }, [])

  const start = useCallback(() => {
    const Ctor = recognitionCtor()
    if (!Ctor) return
    const r = new Ctor()
    r.lang = navigator.language || 'en-US'
    r.continuous = true
    r.interimResults = false
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]
        if (result.isFinal) handler.current(result[0].transcript.trim())
      }
    }
    r.onend = () => setListening(false)
    r.onerror = () => setListening(false)
    recognition.current = r
    r.start()
    setListening(true)
  }, [])

  useEffect(() => () => recognition.current?.stop(), [])

  return { supported, listening, toggle: listening ? stop : start }
}

/** Read text aloud (markdown stripped to plain prose). */
export function useReadAloud() {
  const [supported, setSupported] = useState(false)
  useEffect(() => setSupported(typeof window !== 'undefined' && 'speechSynthesis' in window), [])

  const speak = useCallback((markdown: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
    const text = markdown
      .replace(/```[\s\S]*?```/g, ' (code block) ')
      .replace(/[`*_#>|]/g, '')
      .replace(/\[(.*?)\]\(.*?\)/g, '$1')
      .trim()
    if (!text) return
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text.slice(0, 4000)))
  }, [])

  const cancel = useCallback(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel()
  }, [])

  return { supported, speak, cancel }
}
