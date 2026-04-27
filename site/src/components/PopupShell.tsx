import { ReactNode } from 'react'

interface Props {
  children: ReactNode
  width?: string
}

export default function PopupShell({ children, width = 'w-[360px]' }: Props) {
  return (
    <div
      className={`${width} max-w-full rounded-2xl overflow-hidden border border-border flex-shrink-0`}
      style={{ background: '#0D1117', boxShadow: '0 32px 80px rgba(0,0,0,0.6)' }}
    >
      {children}
    </div>
  )
}
