import type { ReactNode } from 'react'
/** The Host offers plugins React without react-dom; overlays render in place, and their fixed positioning takes them out of the flow. */
export const createPortal = (node: ReactNode, _target: unknown): ReactNode => node
