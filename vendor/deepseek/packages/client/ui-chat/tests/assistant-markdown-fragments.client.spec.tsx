// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { useDisclosure } from '../src/client/chat/use-disclosure.ts'
import { useDetailedPresentation } from './presentation-fixture.client.ts'
import type { AssistantBlock } from '../src/client/contract/snapshot.ts'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../src/client/contract/slots.ts'

afterEach(cleanup)

const t = ((_key: string) => 'label') as ChatViewSlotProps['t']
const renderMessageImages = (() => null) as ChatNodeOwnerProps['renderMessageImages']
const textBlock = (text: string): AssistantBlock => ({ kind: 'text', text })
const reply = (blocks: readonly AssistantBlock[], streaming = false) => (
  <AssistantMarkdown blocks={blocks} streaming={streaming} t={t}
    useDisclosure={useDisclosure} usePresentation={useDetailedPresentation}
    renderMessageImages={renderMessageImages} />
)

describe('assistant Markdown across provider text fragments', () => {
  it.each([false, true])('keeps split emphasis and words in one paragraph (streaming=%s)', (streaming) => {
    // The provider split the real Eris reply at these positions, without newlines.
    const fragments = ['**Fast 档（4', ' 场）**：核心交付完整', '度持平。']
    const live = render(reply(fragments.map(textBlock), streaming))
    expect(live.container.querySelector('strong')?.textContent).toBe('Fast 档（4 场）')
    expect(live.container.querySelectorAll('p')).toHaveLength(1)
    expect(live.container.textContent).toBe('Fast 档（4 场）：核心交付完整度持平。')
  })

  it('preserves authored paragraph breaks, tables and links across fragments', () => {
    const fragments = ['结论。\n\n| 模型 | 胜场 |\n| --', '- | --- |\n| A | 1 |\n\n见 [来', '源](https://example.com/result)。']
    const { container } = render(reply(fragments.map(textBlock)))
    expect(container.querySelectorAll('table')).toHaveLength(1)
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/result')
    expect(container.querySelectorAll('p')).toHaveLength(2)
  })

  it('keeps the same document mounted as a fragment completes and the reply settles', () => {
    const live = render(reply([textBlock('**Fast 档（4')], true))
    const paragraph = live.container.querySelector('p')
    const complete = [textBlock('**Fast 档（4'), textBlock(' 场）**：已核对。')]
    live.rerender(reply(complete, true))
    expect(live.container.querySelector('p')).toBe(paragraph)
    expect(live.container.querySelector('strong')?.textContent).toBe('Fast 档（4 场）')
    live.rerender(reply(complete))
    expect(live.container.querySelector('p')).toBe(paragraph)
    expect(live.container.textContent).toBe('Fast 档（4 场）：已核对。')
  })

  it('keeps non-text boundaries between independent Markdown documents', () => {
    const { container } = render(reply([
      textBlock('**工具前'),
      { kind: 'tool-call', callId: 'lookup', name: 'list_data', argsRaw: '{}' },
      textBlock('工具后**'),
    ]))
    expect(container.querySelector('strong')).toBeNull()
    expect(container.querySelectorAll('p')).toHaveLength(2)
  })
})
