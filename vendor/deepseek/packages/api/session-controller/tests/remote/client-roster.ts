/** The real Gateway client cone without resolving the unrelated complete web-app bundles. */
import { ClientRoster } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/roster.ts'

export { createClientTest } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/vitest.ts'
export type { ClientTestFixtures } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/vitest.ts'
export type { TestClient } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/test-client.ts'

export const API_ROSTER = ClientRoster.of([
  { name: '@deepseek-ai/dsh-client-connection', inject: [], immediately: true },
  { name: '@deepseek-ai/dsh-typert-registry', inject: [], immediately: true },
  { name: '@deepseek-ai/dsh-api-gateway', inject: ['@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-client-connection'], immediately: true },
])
