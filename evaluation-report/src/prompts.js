(() => {
  'use strict';

  const { resources, evaluatorVersion } = window.ReportPromptData;
  const components = [
    { id: 'criteria', name: '验收标准',
      summary: '只阅读任务来源，把共同目标拆成能独立核验的验收项。',
      input: 'source_catalog 中的原问、已有标准答案与候选用户上下文。',
      action: '选择 source_indices → 拆清独立交付、条件与例外 → 区分必需、可选与禁止事项。',
      output: 'requirements、scoring_points、red_flags；每条提交 source_indices 与 text，程序绑定来源和范围。',
      boundary: '该上下文不含候选回答、工具轨迹或 SYS/DEV；不解题，也不创建标准答案。共同判据交给各回答的独立归因任务。',
      rules: [
        ['独立验收', '把任务拆成能分别核验的交付项。'],
        ['不造答案', '检查项里的数值、日期、阈值只可引用所选原文已有的值；需要推算的目标只描述待核任务，计算与事实核验由归因完成。'],
        ['保留范围', '共同问题与私有约束分别列项，不能把共同交付整体变成私有义务。'],
      ],
      fixed: ['criteria/source_rule', 'criteria/reference_rule', 'criteria/task_type'], file: false },
    { id: 'attribution', name: '独立归因',
      summary: '每条回答单独查证，负责事实判断、共同核心可用性与责任归因。',
      input: '固定判据、本方回答与真实规范、调用链、证据目录、表格与引用核验材料。',
      action: '先查反证与必要限制 → 核验逐项状态 → 区分共同核心、私有规则与问题责任。',
      output: '逐项状态、核心结论、数值核对及 strengths / problems；用 basis_index 和证据编号选择真实来源。',
      boundary: '初评只核查本方回答，可见本方版本；不读问题库、不判两两胜负。首次对比前必要时最多补查一轮，两份答案不同本身不证明哪份正确。',
      rules: [
        ['先查反证', '先查整份交付中最可能推翻主结论的反证，再写逐项状态，最后据此写核心结论；不先认定总体可用后为具体错误降级。'],
        ['共同核心', '私规仅评本方，不决定共同核心。'],
        ['真实归责', '模型写错请求/代码、误读正确返回或编造内容归模型；工具自身返回错误且影响结论时才归工具。'],
      ],
      fixed: [], file: false },
    { id: 'comparison', name: '匿名比较',
      summary: '读取匿名材料与已接受归因，每场完成一次同项比较。',
      input: '共同判据、匿名 A/B、只读归因、原始材料与同序 comparison_slots。',
      action: '在固定槽内对照双方事实 → 说明实质优势 → 根据共同核心作出取舍。',
      output: 'a_summary、b_summary、comparisons、preference、tradeoff；程序派生核心状态、排名与正式判决。',
      boundary: '不新增 finding，不改归因或重启补查。来源核心未知或已知材料冲突保留待核。可选独立核验使用新的任务上下文，记录另外保存，不改原判或阻塞交付。',
      rules: [
        ['只读归因', '照录来源的逐项事实和核心可用性，保留既有 findings，不新增或改写归因。'],
        ['不猜优势', '没有同名 finding 不证明另一方没有做到；共同优点不算单方优势。'],
        ['保留取舍', '核心可用者优先于不可用者；双方核心不可用时判都差，tradeoff 仍保留剩余用途、修正代价和已有依据的相对优劣。'],
      ],
      fixed: ['comparison/review_pending', 'comparison/not_applicable'], file: true },
    { id: 'clustering', name: '问题归类',
      summary: '在全部归因后按需整理每个模型的问题知识库。',
      input: '问题观察 items、当前问题库 library 与数量预算 budget。',
      action: '复用同组件已有类 → 按预算新建、合并或维护 → 无合适类且受限时明确延期。',
      output: 'assignments、new_classes、merges、class_updates；保留观察归属与类的主题路径。',
      boundary: '只有该角色持有问题库；读取归因观察，不重新评审原始回答、不改变责任与确定程度。通过 cluster 显式执行，当前默认不自动归类。',
      rules: [
        ['复用已有类', '名称换词、同一缺陷的不同后果或同义描述不足以新建类。'],
        ['不改判', '归类不使待核实的问题变成已确认。'],
        ['不硬归类', '没有合适类且这些限制阻止新建时，填写 `deferred_reason` 说明具体限制；有合适类时不能延期，也不能为了完成归类硬塞进不匹配的类。'],
      ],
      fixed: [], file: false },
    { id: 'rewrite', name: '评语润色',
      summary: '逐个文本槽位润色表达，保留原判、事实与不确定性。',
      input: '已接受评语的文本槽位、只读对照与既定偏好。',
      action: '点出关键得失 → 删除重复推导 → 核对主体、偏好与限定。',
      output: '按 items 顺序返回 texts 字符串数组；Workflow 负责绑定槽位与回填。',
      boundary: '独立文本任务只接收待润色槽位和必要对照，不读取原始证据、问题库或重新判胜负。归因、对比及后置聚类文案默认自动润色，原判词保留。',
      rules: [
        ['事实不变', '保留支撑结论的事实、判断、适用条件和不确定性，不新增事实或扩大错误。'],
        ['逐槽对应', '按 items 的顺序返回 texts 字符串数组，每项一条，不增加、遗漏或换位。'],
        ['偏好不变', '给出了 preference 时，必须以该原值加中文冒号开头，随后解释既定偏好，不遗漏、修改或反转偏好。'],
      ],
      fixed: [], file: false },
    { id: 'shared', name: '共用材料',
      summary: '所有阶段共用的任务材料边界、执行预算与提交反馈。' },
    { id: 'tools', name: '工具说明',
      summary: '各专业组件按自己的工具清单获得对应说明。' },
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
  function appendInline(document, parent, text) {
    let cursor = 0;
    for (const match of text.matchAll(/`[^`\n]+`/g)) {
      parent.append(document.createTextNode(text.slice(cursor, match.index)));
      parent.append(element(document, 'code', 'rp-field', match[0]));
      cursor = match.index + match[0].length;
    }
    parent.append(document.createTextNode(text.slice(cursor)));
  }

  function appendParagraphs(document, parent, text) {
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
      appendInline(document, paragraph, fragment);
      parent.append(paragraph);
    });
  }

  function appendOriginal(document, parent, text, structure = false) {
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
          appendInline(document, words, piece.slice(number.length, headingEnd));
          heading.append(words);
        } else appendInline(document, heading, piece.slice(0, headingEnd));
        body = element(document, 'div', 'rp-rule-body');
        section.append(heading, body);
        parent.append(section);
        appendParagraphs(document, body, piece.slice(headingEnd));
      } else appendParagraphs(document, body, piece);
    });
  }

  function resourceView(document, resource, showName = true) {
    const article = element(document, 'section', 'rp-resource');
    article.dataset.promptResource = resource.id;
    const body = element(document, 'div', 'rp-original');
    body.dataset.promptOriginal = resource.id;
    appendOriginal(document, body, resource.text, resource.id.endsWith('/instructions'));
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
    const overview = element(document, 'div', 'rp-overview');
    const keyRules = element(document, 'section', 'rp-key-rules');
    keyRules.append(element(document, 'h3', 'rp-section-title', '关键规则 · 原文'));
    const list = element(document, 'dl', 'rp-principles');
    const source = byId.get(`${component.id}/instructions`).text;
    component.rules.forEach(([label, quote]) => {
      if (!source.includes(quote)) throw new Error(`关键规则摘录与原文不一致：${component.id} / ${label}`);
      const row = element(document, 'div', 'rp-principle');
      const original = element(document, 'dd', 'rp-principle-quote');
      original.dataset.promptExcerpt = `${component.id}/instructions`;
      appendInline(document, original, quote);
      row.append(element(document, 'dt', 'rp-principle-label', label), original);
      list.append(row);
    });
    keyRules.append(list);
    const workflow = element(document, 'dl', 'rp-workflow');
    [['输入', component.input], ['执行', component.action], ['产出', component.output]].forEach(([label, value]) => {
      const step = element(document, 'div', 'rp-workflow-step');
      step.append(element(document, 'dt', '', label), element(document, 'dd', '', value));
      workflow.append(step);
    });
    overview.append(keyRules, workflow);
    const boundary = element(document, 'section', 'rp-responsibility');
    boundary.append(element(document, 'h3', '', '职责与材料边界'), element(document, 'p', '', component.boundary));
    overview.append(boundary);
    return overview;
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
        panel.replaceChildren(header);
        if (id === 'shared' || id === 'tools') {
          const matching = resources.filter(resource => resource.group === id);
          panel.append(resourceGroup(document, id === 'shared' ? '共用提示原文' : '工具描述原文', matching.map(resource => resource.id)));
        } else {
          panel.append(stageOverview(document, component));
          panel.append(resourceGroup(document, '系统角色', [`${id}/system`], false));
          panel.append(resourceGroup(document, '执行规则', [`${id}/instructions`], false));
          if (component.fixed.length) panel.append(resourceGroup(document, '程序固定文案', component.fixed));
          panel.append(resourceGroup(document, '提交约束', [component.file ? 'tools/submit_evaluation_file' : 'tools/submit_evaluation']));
          if (id === 'comparison') {
            const audit = element(document, 'section', 'rp-verification');
            audit.append(element(document, 'h3', 'rp-section-title', '可选独立核验'));
            audit.append(element(document, 'p', 'rp-verification-boundary', '显式执行 verify-comparisons 后，新的核验任务先只读原材料；提交首查后再揭示归因与已接受对比。核验疑点单独保存，不改原判、不重开归因，也不阻塞改写与交付。'));
            for (const resourceId of ['comparison/verification/system', 'comparison/verification/instructions', 'tools/inspect_material']) audit.append(resourceView(document, byId.get(resourceId)));
            panel.append(audit);
          }
        }
        if (announce) status.textContent = `已显示 ${component.name} 的完整提示词。`;
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
