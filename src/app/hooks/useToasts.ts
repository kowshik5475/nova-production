import { useCallback, useRef, useState } from 'react'
import type { Toast } from '../types'

let toastId = 0

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  const addToast = useCallback((kind: 'success' | 'error', text: string) => {
    const id = ++toastId
    setToasts((t) => [...t, { id, kind, text }])
    const timer = setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id))
      timersRef.current.delete(id)
    }, 3500)
    timersRef.current.set(id, timer)
  }, [])

  const dismissToast = useCallback((id: number) => {
    const timer = timersRef.current.get(id)
    if (timer) { clearTimeout(timer); timersRef.current.delete(id) }
    setToasts((t) => t.filter((x) => x.id !== id))
  }, [])

  return { toasts, addToast, dismissToast }
}
