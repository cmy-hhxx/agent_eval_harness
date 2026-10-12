// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { TrajectoryTable } from '../src/client/TrajectoryTable.tsx'
import { t } from './locale.client.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const schema = {
  name: 'read_evidence', description: Array.from({ length: 24 }, (_, i) => `Description line ${i}`).join('\n'),
  parameters: { type: 'object', additionalProperties: false, required: ['items'], properties: {
    items: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['format'], properties: {
      format: { type: 'string', enum: ['text', 'json'], description: 'Keep the complete source and exact coordinates.' },
    } } },
  } },
}

function inspect(value = schema) {
  const view = render(<TrajectoryTable t={t} renderImages={() => null}
    turns={[{ turn: 1, groups: [{ title: 'Step 1', cells: [{ index: 1, kind: 'tool', text: value.name,
      toolName: value.name, callId: 'evidence-1', timeSeconds: 0.1, schemaDetail: JSON.stringify(value),
    }] }] }]}
    collapsedTurns={new Set()} onToggleTurn={() => {}}
    collapsedAssistants={new Set()} onToggleAssistant={() => {}} />)
  const ui = within(view.container)
  fireEvent.click(ui.getByRole('row', { name: /read_evidence/ }))
  fireEvent.click(ui.getByRole('tab', { name: 'Schema' }))
  return { view, ui }
}

it('shows the complete recorded schema without collapsed nested fields or clipped descriptions', () => {
  const { ui } = inspect()
  const panel = ui.getByRole('tabpanel')
  expect(panel.textContent).toContain(schema.description)
  expect(panel.querySelector('pre')?.textContent).toBe(JSON.stringify(schema.parameters, null, 2))
  expect(panel.textContent).toContain('additionalProperties')
  expect(panel.textContent).toContain('Keep the complete source and exact coordinates.')
})

it('copies the whole call-time definition, including description and all parameter constraints', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const { ui } = inspect()
  fireEvent.click(within(ui.getByRole('tabpanel')).getByRole('button', { name: 'Copy JSON' }))
  await waitFor(() => { expect(writeText).toHaveBeenCalledWith(JSON.stringify(schema)) })
})
