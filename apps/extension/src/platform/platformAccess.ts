// The platform connection for code that isn't handed one explicitly — the workflow canvas and the run commands,
// which are wired up before / apart from the platform views. registerPlatformCatalog provides it on activation;
// until then (or in tests) it is undefined and callers behave as signed out.

import type { PlatformHandle } from './platformHandle'

let current: PlatformHandle | undefined

export function providePlatform(handle: PlatformHandle): void {
  current = handle
}

/** The platform connection, if the extension has one (it may still be disconnected: check `client()`). */
export function platformHandle(): PlatformHandle | undefined {
  return current
}
