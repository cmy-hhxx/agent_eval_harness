(() => {
  'use strict';

  const { resources, evaluatorVersion } = window.ReportPromptData;
  const components = [
    { id: 'criteria', name: '验收标准',
      summary: '只阅读任务来源，把共同目标拆成能独立核验的验收项。',
      flow: {
        source: ['任务来源', '原问 · 已有标准答案 · 用户上下文', '不读取候选回答、工具轨迹或 SYS/DEV。'],
        steps: [
          ['选择原文来源', '保留来源编号与适用条件', 1],
          ['拆分独立交付', '每一项都能单独核验', 0],
          ['区分要求与范围', '共同要求与私有约束分别列项', 2],
        ],
        result: ['验收清单', '必需交付 · 可选加分 · 明确禁止', '共同判据交给各回答的独立归因任务。'],
      },
      boundary: '该上下文不含候选回答、工具轨迹或 SYS/DEV；不解题，也不创建标准答案。共同判据交给各回答的独立归因任务。',
      rules: [
        ['独立验收', '把任务拆成能分别核验的交付项。', '能分别核验的交付项'],
        ['不造答案', '检查项里的数值、日期、阈值只可引用所选原文已有的值；需要推算的目标只描述待核任务，计算与事实核验由归因完成。', '只可引用所选原文已有的值'],
        ['保留范围', '共同问题与私有约束分别列项，不能把共同交付整体变成私有义务。', '共同问题与私有约束分别列项'],
      ],
      fixed: ['criteria/source_rule', 'criteria/reference_rule', 'criteria/task_type'], file: false },
    { id: 'attribution', name: '独立归因',
      summary: '每条回答单独查证，负责事实判断、共同核心可用性与责任归因。',
      flow: {
        source: ['一份回答与核验材料', '共同判据 · 本方回答 · 证据目录', '初评只看本方回答；必要时对比前补查。'],
        steps: [
          ['先查关键反证', '检查主结论和必要限制', 0],
          ['核验共同核心', '记录逐项状态与数值核对', 1],
          ['定位问题责任', '区分模型、工具与其他组件', 2],
        ],
        result: ['本方归因结果', '核心结论 · 优点 · 问题与证据', '交给匿名比较；该阶段不判两两胜负。'],
      },
      boundary: '初评只核查本方回答，可见本方版本；不读问题库、不判两两胜负。首次对比前必要时最多补查一轮，两份答案不同本身不证明哪份正确。',
      rules: [
        ['先查反证', '先查整份交付中最可能推翻主结论的反证，再写逐项状态，最后据此写核心结论；不先认定总体可用后为具体错误降级。', '先查整份交付中最可能推翻主结论的反证'],
        ['共同核心', '私规仅评本方，不决定共同核心。', '私规仅评本方，不决定共同核心'],
        ['真实归责', '模型写错请求/代码、误读正确返回或编造内容归模型；工具自身返回错误且影响结论时才归工具。', '工具自身返回错误且影响结论时才归工具'],
      ],
      fixed: [], file: false },
    { id: 'comparison', name: '匿名比较',
      summary: '读取匿名材料与已接受归因，每场完成一次同项比较。',
      flow: {
        source: ['匿名 A / B 与归因', '共同判据 · 只读归因 · 原始材料', '两份材料按同一组比较槽位对齐。'],
        steps: [
          ['照录既有事实', '保持原归因和核心可用性', 0],
          ['逐项比较差异', '说明有依据的实质优势', 1],
          ['按共同核心取舍', '保留优势、用途和修正代价', 2],
        ],
        result: ['比较结果', '逐项对照 · 偏好判断 · 取舍理由', '程序派生正式判决；核心未知或材料冲突时保留待核。'],
      },
      boundary: '不新增 finding，不改归因或重启补查。来源核心未知或已知材料冲突保留待核。可选独立核验使用新的任务上下文，记录另外保存，不改原判或阻塞交付。',
      rules: [
        ['只读归因', '照录来源的逐项事实和核心可用性，保留既有 findings，不新增或改写归因。', '不新增或改写归因'],
        ['不猜优势', '没有同名 finding 不证明另一方没有做到；共同优点不算单方优势。', '共同优点不算单方优势'],
        ['保留取舍', '核心可用者优先于不可用者；双方核心不可用时判都差，tradeoff 仍保留剩余用途、修正代价和已有依据的相对优劣。', '双方核心不可用时判都差'],
      ],
      fixed: ['comparison/review_pending', 'comparison/not_applicable'], file: true },
    { id: 'clustering', name: '问题归类',
      summary: '在全部归因后按需整理每个模型的问题知识库。',
      flow: {
        source: ['问题观察与知识库', '本模型的问题 · 当前类库 · 数量预算', '仅在归因后按需执行，每个模型一份问题库。'],
        steps: [
          ['查找同组件已有类', '有合适类就复用', 0],
          ['检查类库数量预算', '无合适类时再考虑新建', 2],
          ['维护类别与归属', '记录分配、合并和类状态', 1],
        ],
        result: ['更新后的问题库', '观察归属 · 类别变更 · 延期原因', '无匹配类且新增受限时明确延期，不强行归类。'],
      },
      boundary: '只有该角色持有问题库；读取归因观察，不重新评审原始回答、不改变责任与确定程度。通过 cluster 显式执行，当前默认不自动归类。',
      rules: [
        ['复用已有类', '名称换词、同一缺陷的不同后果或同义描述不足以新建类。', '不足以新建类'],
        ['不改判', '归类不使待核实的问题变成已确认。', '不使待核实的问题变成已确认'],
        ['不硬归类', '没有合适类且这些限制阻止新建时，填写 `deferred_reason` 说明具体限制；有合适类时不能延期，也不能为了完成归类硬塞进不匹配的类。', '不能为了完成归类硬塞进不匹配的类'],
      ],
      fixed: [], file: false },
    { id: 'rewrite', name: '评语润色',
      summary: '逐个文本槽位润色表达，保留原判、事实与不确定性。',
      flow: {
        source: ['已接受的评语', '文本槽位 · 必要对照 · 既定偏好', '只读取待润色文本，不读取原始证据。'],
        steps: [
          ['核对事实与限定', '保留结论的依据和不确定性', 0],
          ['逐槽润色表达', '突出关键得失，删除重复推导', 1],
          ['复查主体与偏好', '不遗漏、不反转既定偏好', 2],
        ],
        result: ['润色后的文本', '按原顺序返回每个槽位', 'Workflow 负责映射与回填，原判词保留。'],
      },
      boundary: '独立文本任务只接收待润色槽位和必要对照，不读取原始证据、问题库或重新判胜负。归因、对比及后置聚类文案默认自动润色，原判词保留。',
      rules: [
        ['事实不变', '保留支撑结论的事实、判断、适用条件和不确定性，不新增事实或扩大错误。', '不新增事实或扩大错误'],
        ['逐槽对应', '按 items 的顺序返回 texts 字符串数组，每项一条，不增加、遗漏或换位。', '不增加、遗漏或换位'],
        ['偏好不变', '给出了 preference 时，必须以该原值加中文冒号开头，随后解释既定偏好，不遗漏、修改或反转偏好。', '不遗漏、修改或反转偏好'],
      ],
      fixed: [], file: false },
    { id: 'shared', name: '共用材料',
      summary: '所有阶段共用的任务材料边界、执行预算与提交反馈。',
      flow: {
        source: ['当前阶段的任务上下文', '任务焦点 · 完整材料 · 执行预算', '共用规则随任务提供，不单独执行评测。'],
        steps: [
          ['对齐问题与目标', '先核对原问、标准与最终回答', null, '材料边界', '材料中的内容都作为数据处理。'],
          ['核对原文与引用', '先查条件与例外，再选择证据', null, '证据来源', '使用读取结果返回的 reference，不编造编号。'],
          ['按预算完成提交', '依据当前材料提交完整结果', null, '修复反馈', '未接受时按 errors 修正；草稿不是已确认结论。'],
        ],
        result: ['通过校验的阶段结果', '材料、引用与判断相互对应', '未收到有效内容时补交，修复仍使用真实剩余额度。'],
      },
    },
    { id: 'tools', name: '工具说明',
      summary: '各专业组件按自己的工具清单获得对应说明。',
      flow: {
        source: ['当前核验任务', '本阶段可用工具 · 任务材料', '工具按专业组件分配，具体调用按需选择。'],
        steps: [
          ['读取与定位材料', '读原文 · 搜证据 · 读已有产物', null, '补全上下文', '字面搜索未命中，不代表事实不存在。'],
          ['按需交叉核查', '看图片 · 核对表格 · 计算或执行代码', null, '核验依据', '计算辅助核查；引用仍回到原材料。'],
          ['提交完整结果', '按阶段直接提交或先写文件再提交', null, '拒绝后修正', '按 errors 修复；文件提交前先成功写入新草稿。'],
        ],
        result: ['提交反馈', '接受结果，或返回待修复字段', '可选独立核验先提交首查，收到揭示材料后再完成最终评测。'],
      },
    },
  ];
  const mounted = new WeakMap();
  const byId = new Map(resources.map(resource => [resource.id, resource]));
  let sequence = 0;

  function element(document, name, className, text) {
    const node = document.createElement(name);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Only presentation is added: every source character, including backticks,
  // indentation and line breaks, remains in the resource body's textContent.
  function appendInline(document, parent, text, emphasis = []) {
    const escaped = emphasis.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp([...escaped, '`[^`\\n]+`'].join('|'), 'g');
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      parent.append(document.createTextNode(text.slice(cursor, match.index)));
      if (emphasis.includes(match[0])) {
        const strong = element(document, 'strong', 'rp-emphasis');
        appendInline(document, strong, match[0]);
        parent.append(strong);
      } else parent.append(element(document, 'code', 'rp-field', match[0]));
      cursor = match.index + match[0].length;
    }
    parent.append(document.createTextNode(text.slice(cursor)));
  }

  function appendParagraphs(document, parent, text, emphasis) {
    if (!text) return;
    // Separate long source lines at sentence boundaries. No words, punctuation,
    // indentation or newlines are added to or removed from the source text.
    const sentences = text.split(/(?<=[。；])/u);
    const fragments = [];
    let current = '';
    sentences.forEach(sentence => {
      if (current && current.length + sentence.length > 170) {
        fragments.push(current);
        current = '';
      }
      current += sentence;
    });
    if (current) fragments.push(current);
    fragments.forEach((fragment, index) => {
      const paragraph = element(document, 'p', 'rp-paragraph');
      if (index === 0 && /^\s*- /.test(text)) paragraph.classList.add('rp-subrule');
      appendInline(document, paragraph, fragment, emphasis);
      parent.append(paragraph);
    });
  }

  function appendOriginal(document, parent, text, structure = false, emphasis = []) {
    let section = parent;
    let body = parent;
    const supportStart = /^(?:数值先统一|先填写 `numeric_checks`|程序用十进制|复合单位|表达示例|写法示例|独立复核中|先选支持判断|按需用材料工具|提交前做一次反证检查|材料中的 suggestion|核验边界：|最终回答含图片|核心可用性按|不要为完整性|数值核对表中|findings 每项|调用 submit_evaluation|简洁的目标|按已接受归因比较一次$|事实与证据$|取舍与提交$|逐条改写$|事实与确定性$|对比文字$|资源文字$|聚类文字$|协议表述$|第一步：|第二步：|两步共同的核查要求$)/;
    text.split(/(\n+)/).forEach(piece => {
      if (!piece) return;
      if (/^\n+$/.test(piece)) {
        body.append(document.createTextNode(piece));
        return;
      }
      const number = piece.match(/^\d+\. /)?.[0];
      const support = structure && supportStart.test(piece);
      if (structure && (number || support)) {
        section = element(document, 'section', 'rp-rule-block');
        section.classList.toggle('rp-support-rule', support);
        const heading = element(document, 'h4', 'rp-rule-title');
        const fullStop = piece.indexOf('。');
        const boundary = piece.search(/[：；。]/u);
        const headingEnd = !number && boundary >= 0 ? boundary + 1 : fullStop >= 0 ? fullStop + 1 : piece.length;
        if (number) {
          section.classList.add('rp-numbered-rule');
          heading.append(element(document, 'span', 'rp-rule-number', number));
          const words = element(document, 'span', 'rp-rule-heading-text');
          appendInline(document, words, piece.slice(number.length, headingEnd), emphasis);
          heading.append(words);
        } else appendInline(document, heading, piece.slice(0, headingEnd), emphasis);
        body = element(document, 'div', 'rp-rule-body');
        section.append(heading, body);
        parent.append(section);
        appendParagraphs(document, body, piece.slice(headingEnd), emphasis);
      } else appendParagraphs(document, body, piece, emphasis);
    });
  }

  function resourceView(document, resource, showName = true) {
    const article = element(document, 'section', 'rp-resource');
    article.dataset.promptResource = resource.id;
    const body = element(document, 'div', 'rp-original');
    body.dataset.promptOriginal = resource.id;
    const emphasis = components.find(component => component.id === resource.group)?.rules?.map(rule => rule[2]) ?? [];
    appendOriginal(document, body, resource.text, resource.id.endsWith('/instructions'), emphasis);
    if (showName) article.append(element(document, 'h4', 'rp-resource-name', resource.name));
    article.append(body);
    return article;
  }

  function resourceGroup(document, title, ids, showNames = true) {
    const group = element(document, 'section', 'rp-section');
    group.append(element(document, 'h3', 'rp-section-title', title));
    ids.forEach(id => {
      const resource = byId.get(id);
      if (resource) group.append(resourceView(document, resource, showNames));
    });
    return group;
  }

  function stageOverview(document, component) {
    const figure = element(document, 'figure', 'rp-flow');
    figure.setAttribute('aria-label', `${component.name}处理流程`);
    const chain = element(document, 'ol', 'rp-flow-chain');
    const { source, steps, result } = component.flow;
    const entries = [
      { title: source[0], detail: source[1], note: source[2], kind: 'input' },
      ...steps.map(([title, detail, rule, noteTitle, note]) => ({ title, detail, rule, noteTitle, note, kind: 'step' })),
      { title: result[0], detail: result[1], note: result[2], kind: 'output' },
    ];
    entries.forEach((entry, index) => {
      const row = element(document, 'li', 'rp-flow-entry');
      row.dataset.promptNode = entry.kind;
      if (index) {
        const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        arrow.setAttribute('class', 'rp-flow-arrow');
        arrow.setAttribute('viewBox', '0 0 24 32');
        arrow.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS(arrow.namespaceURI, 'path');
        path.setAttribute('d', 'M12 0V28 M7 23L12 28L17 23');
        arrow.append(path);
        row.append(arrow);
      }
      const node = element(document, 'div', 'rp-flow-node');
      node.append(element(document, 'h3', '', entry.title), element(document, 'p', '', entry.detail));
      row.append(node);
      if (Number.isInteger(entry.rule)) {
        const [label, quote, emphasis] = component.rules[entry.rule];
        const resourceId = `${component.id}/instructions`;
        if (!byId.get(resourceId).text.includes(quote) || !quote.includes(emphasis)) {
          throw new Error(`关键规则摘录与原文不一致：${component.id} / ${label}`);
        }
        const rule = element(document, 'details', 'rp-flow-rule');
        const summary = element(document, 'summary');
        summary.append(element(document, 'span', 'rp-flow-rule-label', label));
        summary.append(element(document, 'span', 'rp-flow-rule-caption', emphasis));
        const original = element(document, 'p', 'rp-flow-quote');
        original.dataset.promptExcerpt = resourceId;
        appendInline(document, original, quote, [emphasis]);
        rule.append(summary, original);
        row.append(rule);
      } else {
        const note = element(document, 'div', 'rp-flow-note');
        if (entry.noteTitle) note.append(element(document, 'h3', '', entry.noteTitle));
        note.append(element(document, 'p', '', entry.note));
        row.append(note);
      }
      chain.append(row);
    });
    figure.append(chain);
    return figure;
  }

  window.ReportPrompts = {
    evaluatorVersion,
    data: resources,
    render(container) {
      if (!container || container.nodeType !== 1) throw new TypeError('提示词阅读区需要一个页面容器。');
      mounted.get(container)?.destroy();
      const document = container.ownerDocument;
      const prefix = `prompt-reader-${++sequence}`;
      let selected = 'criteria';
      let destroyed = false;
      const root = element(document, 'div', 'rp-reader');
      const sidebar = element(document, 'aside', 'rp-sidebar');
      const tabs = element(document, 'div', 'rp-components');
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('aria-label', '评测提示词组件');
      tabs.setAttribute('aria-orientation', 'vertical');
      const buttons = new Map();
      components.forEach((component, index) => {
        const button = element(document, 'button', 'rp-component');
        button.type = 'button';
        button.id = `${prefix}-tab-${component.id}`;
        button.dataset.promptComponent = component.id;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-controls', `${prefix}-panel`);
        if (index === 5) button.classList.add('rp-component-divider');
        button.append(element(document, 'span', 'rp-component-name', component.name));
        tabs.append(button);
        buttons.set(component.id, button);
      });
      const panel = element(document, 'article', 'rp-reading');
      panel.id = `${prefix}-panel`;
      panel.setAttribute('role', 'tabpanel');
      panel.tabIndex = 0;
      const status = element(document, 'p', 'visually-hidden');
      status.setAttribute('role', 'status');
      sidebar.append(tabs);
      root.append(sidebar, panel, status);
      container.replaceChildren(root);

      function select(id, { focus = false, announce = true } = {}) {
        if (destroyed) return;
        const component = components.find(item => item.id === id);
        if (!component) throw new RangeError(`未知提示词组件：${id}`);
        selected = id;
        buttons.forEach((button, key) => {
          button.setAttribute('aria-selected', String(key === id));
          button.tabIndex = key === id ? 0 : -1;
        });
        panel.setAttribute('aria-labelledby', buttons.get(id).id);
        const header = element(document, 'header', 'rp-heading');
        header.append(element(document, 'h2', 'rp-heading-title', component.name));
        header.append(element(document, 'p', 'rp-heading-summary', component.summary));
        const original = element(document, 'details', 'rp-full-prompt');
        original.append(element(document, 'summary', '', '完整提示词'));
        panel.replaceChildren(header, stageOverview(document, component), original);
        if (id === 'shared' || id === 'tools') {
          const matching = resources.filter(resource => resource.group === id);
          original.append(resourceGroup(document, id === 'shared' ? '共用提示原文' : '工具描述原文', matching.map(resource => resource.id)));
        } else {
          const boundary = element(document, 'section', 'rp-responsibility');
          boundary.append(element(document, 'h3', '', '职责与材料边界'), element(document, 'p', '', component.boundary));
          original.append(boundary);
          original.append(resourceGroup(document, '系统角色', [`${id}/system`], false));
          original.append(resourceGroup(document, '执行规则', [`${id}/instructions`], false));
          if (component.fixed.length) original.append(resourceGroup(document, '程序固定文案', component.fixed));
          original.append(resourceGroup(document, '提交约束', [component.file ? 'tools/submit_evaluation_file' : 'tools/submit_evaluation']));
          if (id === 'comparison') {
            const audit = element(document, 'section', 'rp-verification');
            audit.append(element(document, 'h3', 'rp-section-title', '可选独立核验'));
            audit.append(element(document, 'p', 'rp-verification-boundary', '显式执行 verify-comparisons 后，新的核验任务先只读原材料；提交首查后再揭示归因与已接受对比。核验疑点单独保存，不改原判、不重开归因，也不阻塞改写与交付。'));
            for (const resourceId of ['comparison/verification/system', 'comparison/verification/instructions', 'tools/inspect_material']) audit.append(resourceView(document, byId.get(resourceId)));
            original.append(audit);
          }
        }
        if (announce) status.textContent = `已显示 ${component.name} 的处理流程与提示词。`;
        if (focus) buttons.get(id).focus();
      }

      function click(event) {
        const button = event.target.closest?.('[data-prompt-component]');
        if (button && tabs.contains(button)) select(button.dataset.promptComponent);
      }

      function keydown(event) {
        const button = event.target.closest?.('[data-prompt-component]');
        if (!button || !tabs.contains(button)) return;
        const index = components.findIndex(item => item.id === button.dataset.promptComponent);
        let next;
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % components.length;
        else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + components.length) % components.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = components.length - 1;
        else return;
        event.preventDefault();
        select(components[next].id, { focus: true });
      }

      tabs.addEventListener('click', click);
      tabs.addEventListener('keydown', keydown);
      const controller = {
        select,
        get selected() { return selected; },
        destroy() {
          if (destroyed) return;
          destroyed = true;
          tabs.removeEventListener('click', click);
          tabs.removeEventListener('keydown', keydown);
          if (mounted.get(container) === controller) mounted.delete(container);
        },
      };
      mounted.set(container, controller);
      select(selected, { announce: false });
      return controller;
    },
  };
})();
