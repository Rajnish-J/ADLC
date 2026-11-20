import { redirect } from 'next/navigation'

/** Git connections moved into Settings. */
export default function GitConnectionsPage() {
  redirect('/settings/git-connections')
}
