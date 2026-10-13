import { describe, expect, it, vi } from 'vitest'
import type { ModelSelection, ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ModelCatalogDirectory } from '../src/client/catalog.ts'
import { ModelDirectory } from '../src/client/directory.ts'

function fixture() {
  const initial: ModelSelection = { provider: 'fixture', model: 'model', reasoningEffort: 'high' }
  const selected = { ...initial, reasoningEffort: 'max' }
  const projected = createSnapshotStore<ModelSelectionProjection>({ lastUsed: null, next: initial })
  const catalog = new ModelCatalogDirectory({ remote: { session: { modelCatalog: async () => ({
    ok: true, value: { default: initial, routableProviders: ['fixture'], failures: [],
      groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: 'model', name: 'Model' }] }] },
  }) } } } as never)
  const selectModel = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  const directory = new ModelDirectory({ selectModel }, 'session' as SessionId, () => true, catalog, projected, () => false)
  return { initial, selected, projected, selectModel, directory }
}

describe('ModelDirectory selection acknowledgement', () => {
  it('keeps the accepted effort until the durable selection changes, then follows later updates', async () => {
    const { initial, selected, projected, directory } = fixture()
    try {
      await directory.load()
      await directory.select(selected)
      expect(directory.store.getSnapshot()).toMatchObject({ current: selected, status: 'ready', pending: null })
      // An unchanged projection can be republished before the selection stream catches up.
      projected.set({ lastUsed: initial, next: { ...initial } })
      expect(directory.store.getSnapshot().current).toEqual(selected)
      projected.set({ lastUsed: initial, next: selected })
      expect(directory.store.getSnapshot().current).toEqual(selected)
      const external = { ...initial, reasoningEffort: 'off' }
      projected.set({ lastUsed: selected, next: external })
      expect(directory.store.getSnapshot().current).toEqual(external)

      await directory.select(selected)
      directory.resetConnected()
      expect(directory.store.getSnapshot().current).toEqual(external)
    } finally { directory.dispose() }
  })

  it.each([
    { name: 'a newer external selection', updates: ['max', 'off'], expected: 'off' },
    { name: 'a selection changed back to the initial value', updates: ['max', 'high'], expected: 'high' },
    { name: 'an unchanged selection republished before acknowledgement', updates: ['high'], expected: 'max' },
    { name: 'the acknowledged selection already projected', updates: ['max'], expected: 'max' },
  ])('preserves $name when an acknowledgement arrives late', async ({ updates, expected }) => {
    const { initial, selected, projected, selectModel, directory } = fixture()
    const response = Promise.withResolvers<{ ok: true; value: undefined }>()
    selectModel.mockReturnValue(response.promise)
    try {
      await directory.load()
      const selecting = directory.select(selected)
      for (const reasoningEffort of updates)
        projected.set({ lastUsed: initial, next: { ...initial, reasoningEffort } })
      response.resolve({ ok: true, value: undefined })
      await selecting
      expect(directory.store.getSnapshot()).toMatchObject({
        current: { ...initial, reasoningEffort: expected }, status: 'ready', pending: null,
      })
      const durable = projected.getSnapshot().next!
      projected.set({ lastUsed: durable, next: { ...durable } })
      expect(directory.store.getSnapshot().current?.reasoningEffort).toBe(expected)
    } finally { directory.dispose() }
  })
})
