// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ComponentProps } from 'react'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { AssistantNodeView } from '../src/client/chat/AssistantNodeView.tsx'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'
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

describe('final-response visuals', () => {
  it.each(['', '\n\n```chart\n5eece766-4811-4742-b81c-a3411b3e926e\n```', '\n\n```chart\none\n```\n\n```chart\ntwo\n```'])
    ('places application visuals once before the final response, regardless of chart placeholders %s', (placeholder) => {
      const snapshot = chatSnapshotFixture({ nodes: [{ kind: 'assistant', seq: 1, time: 1000, turn: 7, step: 2,
        blocks: [textBlock('Final answer.' + placeholder)] }] })
      const node = [...snapshot.nodes.values()].find(node => node.kind === 'assistant-step')!
      const props = {
        node, groupPart: 'response', useDisclosure, useTurnData: () => undefined, usePresentation: useDetailedPresentation,
        renderMessageImages, fileMentions: () => undefined, openFile: () => {}, t,
        turnProcess: { hasContent: true, foldable: true, open: false, setOpen: () => {},
          spec: { turn: 7, controlAnchorSeq: 1, processStartSeq: 1, answerAnchorSeq: 1, answerStep: 2, inlineReasoning: false, messageCount: 1, toolCallCount: 1, subagentCount: 0 } },
        renderSlot: (name: string, owner: { turn: number }) => name === 'conversation.chat.visuals'
          ? <figure data-visual-turn={owner.turn}>Accepted chart</figure> : <></>,
      } as ComponentProps<typeof AssistantNodeView>
      const live = render(<AssistantNodeView {...props} />)
      expect(live.container.querySelectorAll('figure')).toHaveLength(1)
      expect(live.container.textContent?.trimEnd()).toBe('Accepted chartFinal answer.')
      expect(live.container.querySelector('figure')?.getAttribute('data-visual-turn')).toBe('7')
      live.rerender(<AssistantNodeView {...props} groupPart="reasoning" />)
      expect(live.container.querySelectorAll('figure')).toHaveLength(0)
      live.rerender(<AssistantNodeView {...props} turnProcess={{ ...props.turnProcess!, spec: { ...props.turnProcess!.spec, answerStep: 3 } }} />)
      expect(live.container.querySelectorAll('figure')).toHaveLength(0)
    })
})

describe('assistant Markdown across provider text fragments', () => {
  it.each([false, true])('keeps split emphasis and words in one paragraph (streaming=%s)', (streaming) => {
    // The provider split the real Eris reply at these positions, without newlines.
    const fragments = ['**Fast 档（4', ' 场）**：核心交付完整', '度持平。']
    const live = render(reply(fragments.map(textBlock), streaming))
    expect(live.container.querySelector('strong')?.textContent).toBe('Fast 档（4 场）')
    expect(live.container.querySelectorAll('p')).toHaveLength(1)
    expect(live.container.textContent).toBe('Fast 档（4 场）：核心交付完整度持平。')
  })

  it.each([false, true])('preserves paragraphs and tables with plain source labels (streaming=%s)', (streaming) => {
    const fragments = ['结论。\n\n| 模型 | 胜场 |\n| --', '- | --- |\n| A | 1 |\n\n见 [来', '源](https://example.com/result)。']
    const { container } = render(reply(fragments.map(textBlock), streaming))
    expect(container.querySelectorAll('table')).toHaveLength(1)
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('见 来源。')
    expect(container.querySelectorAll('p')).toHaveLength(2)
  })

  it.each([false, true])('renders authored, reference and automatic web links as text (streaming=%s)', (streaming) => {
    const text = '见 [**机构公告**](https://example.com/a) 和 https://example.com/b。\n\n另见 [来源][ref]。\n\n[ref]: https://example.com/c\n\n`https://example.com/code`'
    const { container } = render(reply([textBlock(text)], streaming))
    expect(container.querySelector('a[href^="http"]')).toBeNull()
    expect(container.querySelector('strong')?.textContent).toBe('机构公告')
    expect(container.textContent).toContain('https://example.com/b')
    expect(container.querySelector('code')?.textContent).toBe('https://example.com/code')
  })

  it('keeps mixed-language labels bold while streaming, settling and restoring', () => {
    const text = '**Fast：**B组目前占优。**Expert：**胜负接近。\n\n**边界：**整体归因尚未完成。'
    const live = render(reply([], true))
    for (let end = 1; end <= text.length; end++) {
      live.rerender(reply([textBlock(text.slice(0, end))], true))
    }
    const check = (container: HTMLElement) => {
      expect([...container.querySelectorAll('strong')].map(node => node.textContent))
        .toEqual(['Fast：', 'Expert：', '边界：'])
      expect(container.textContent).not.toContain('**')
    }
    check(live.container)
    live.rerender(reply([textBlock(text)]))
    check(live.container)
    live.unmount()
    check(render(reply([textBlock(text)])).container)
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
