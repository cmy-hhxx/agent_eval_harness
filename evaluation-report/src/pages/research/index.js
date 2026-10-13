(() => {
  'use strict';
  const escape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  window.ReportResearch = {
    render(container, report, data) {
      const sourceLink = (id, label) => { const source = data.sources.find(item => item.id === id); return `<a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer">${label}</a>`; };
      const table = (headers, rows) => `<div class="research-table" role="region" aria-label="${escape(headers[0])}对照表" tabindex="0"><table><thead><tr>${headers.map(item => `<th scope="col">${item}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(item => `<td>${item}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      const heading = title => `<div class="research-section-heading"><h2>${title}</h2></div>`;
      const status = (label, kind = '') => `<span class="research-status ${kind}">${label}</span>`;
      const pairs = report.cases.flatMap(item => item.pairs);
      const decided = pairs.filter(item => item.status === 'decided').length;
      const panels = [
        { id:'overview', title:'汇报摘要', html: `
          ${heading('已有评测底座，下一步证明评得准')}
          <p class="research-lead">保留现有框架，优先补齐<strong>人工校准、分层实验、问题回归</strong>。</p>
          <div class="research-strip">
            <div class="research-stat"><strong>${report.cases.length} 题</strong><span>真实业务案例</span></div>
            <div class="research-stat"><strong>${pairs.length} 场</strong><span>${decided} 场正式 · ${pairs.length - decided} 场待核</span></div>
            <div class="research-stat"><strong>5 / 6</strong><span><a href="#experiments">固定六题：比较阶段重复 / 换位一致</a></span></div>
            <div class="research-stat"><strong>待验证</strong><span>裁判准确性</span></div>
          </div>
          <div class="research-columns">
            <article><h3>保留：证据驱动的评测链</h3><p>共同判据 → 分别归因 → 匿名比较。已有校准、换位与统计工具，可直接开展验证。</p><a class="research-link" href="#flow">查看真实案例 →</a></article>
            <article><h3>补齐：裁判可信度</h3><p>专家独立标注并仲裁，检查严重误判；分别验证比较阶段与完整链路。</p></article>
            <article><h3>建立：问题回归闭环</h3><p>同题同预算比较方案，问题进入回归集，修复后复测，持续衡量质量与成本。</p></article>
          </div>
          <div class="research-callout"><strong>建议先做 8–12 周试点</strong>1 名工程负责人，业务专家投入 0.3–0.5 人力当量；从 30–50 题人工标注开始。</div>
          ${heading('把先进性拆成四件可以验收的事')}
          ${table(['验收方向','可交付证据','当前状态'],[
            ['评得准','有来源支撑的人工审定集；逐类混淆、严重误判与区间','工具已具备，代表性人工校准待开展'],
            ['评得稳','独立 run 的重复与换位；失败、未知和缺失单列','已有六题诊断实验，需扩大样本和链路范围'],
            ['改得动','问题引用 → 修复 → 固定回归复测；记录复发率','已有问题库，闭环执行与效果待验证'],
            ['成本可控','被评系统与评测器分别记录质量、耗时和费用','已有用量与运行机制，需建立同口径对照']
          ])}
        `},
        { id:'benchmarks', title:'美团与字节', html: `
          ${heading('美团做标准治理，字节做分层诊断')}
          <div class="research-pair">
            <article class="research-company"><h3>${sourceLink('meituan','美团：标准与业务对齐')}</h3><p class="research-subtitle">围绕结果、过程、效率和安全定义任务指标。</p>
              <ol class="research-steps"><li><strong>先定义任务完成</strong>把业务目标拆成可核验要求；原子项尽量明确，无法确认的状态保留未知。</li><li><strong>先人人对齐，再人机校准</strong>专家独立评价、处理分歧，再核对机器裁判；观察未知率与标准歧义。</li><li><strong>让生产样本回到评测</strong>采集、清洗、评测、质检与归因连续运行；长任务记录输入、预期行为与轨迹。</li><li><strong>回归成为发布依据</strong>固定测试与执行条件，持续检验改动是否带来真实收益。</li></ol>
              <div class="research-callout"><strong>迁移到我们</strong>共同 Criteria 已有。优先补专家对齐、争议规则正反例和回归样本运营；保留未知、部分满足与整体可用性的区别。</div>
            </article>
            <article class="research-company"><h3>${sourceLink('bytedance','字节：三层定位与工具复算')}</h3><p class="research-subtitle">基础能力做选型，组件做诊断，端到端做业务验收。</p>
              <ol class="research-steps"><li><strong>按三层问题选择评测集</strong>模型是否有能力、哪一步出错、用户任务是否完成，分别取证。</li><li><strong>Critic 初评、Reflect 复查</strong>让评测侧主动核查，复查初判；组合多角色与模型处理复杂分析。</li><li><strong>用执行证据纠正文字判断</strong>ReAct 编码复算数值；SQL 专域通过结构归一化与匹配减少表面差异干扰。</li><li><strong>数据集、人工和机器一起迭代</strong>线上案例回流，规则与模型算子组合；深度和易读性仍保留人工边界。</li></ol>
              <div class="research-callout"><strong>迁移到我们</strong>已有归因、比较与代码核验。先分层实验，再比较增加复查或异模型核验是否减少严重错判。</div>
            </article>
          </div>
          ${heading('放到同一张表：借鉴动作与验收证据')}
          ${table(['外部做法','我们已有','下一步动作','完成的证明'],[
            ['美团 · 标准治理','共同 Criteria 与逐项状态','专家双标、仲裁；修订高分歧规则','逐项分歧与未知原因可追溯'],
            ['字节 · 三层评测','组件可冻结，已有比较阶段实验','拆开模型选型、评测组件、业务全链路实验','每份结果写清评测对象和冻结边界'],
            ['字节 · 复算与复查','证据引用、代码工具、可选核验','对照当前链路与异模型核验；只改一个因素','严重误判变化与增量成本同时报告'],
            ['美团 · 样本闭环','跨 run 问题库、持续取数','重点问题转人工确认回归样本','修复后复测，记录复发与关闭时间']
          ])}
          <div class="research-pair">
            <article><h3>${sourceLink('aws','AWS：分别验结果与过程')}</h3><p>借鉴任务状态核对：工具执行成功后，继续检查实际交付。</p></article>
            <article><h3>${sourceLink('qianwen','千问：补充通用评测维度')}</h3><p>任务、决策、交互、轨迹与输出的概念框架，供检查维度是否完整。</p></article>
          </div>
        `},
        { id:'options', title:'轻量方案', html: `
          ${heading('保留当前框架，按需试用轻量工具')}
          ${table(['来源 / 类型','值得吸收','部署与边界','当前取舍'],[
            [sourceLink('anthropicEval','Anthropic'),'任务、轨迹、结果和裁判分离；重复采样','方法文章，无部署依赖','用于实验协议'],
            [sourceLink('promptfoo','promptfoo'),'声明式断言、回归、CI 与红队样本','MIT；Node CLI 本地运行','可选隔离试点'],
            [sourceLink('deepevalTS','DeepEval'),'组件与轨迹评分、测试门禁','Apache 2.0；TypeScript beta，功能与 Python 不完全等价','小样本交叉对照'],
            [sourceLink('inspect','Inspect'),'任务、执行与评分分离；重复和统计','MIT；Python，工具环境按任务配置','借鉴实验组织'],
            [sourceLink('langsmithReview','LangSmith'),'人工标注、争议审阅与反馈','商业平台；完整自托管需 Enterprise','借鉴人审流程']
          ])}
          <div class="research-callout"><strong>引入条件：减少误判或审阅工时，增量成本可接受</strong>先在同一人工审定集上对照；Harbor 类重部署方案暂不引入。</div>
          ${heading('更新的研究，优先用来测我们的评测器')}
          ${table(['一手研究','解决的问题','适合我们的实验'],[
            [sourceLink('tau','τ²-bench'),'用户与 Agent 共同改变状态，分离推理与协调','先为高频任务增加结果断言'],
            [sourceLink('agentrx','AgentRx'),'沿轨迹定位失败，组合约束与证据检查','为归因器设计受控故障小集'],
            [sourceLink('whowhen','Who&When Pro'),'注入受控故障，检验出错角色与步骤','测试责任定位与错误传播']
          ])}
        `},
        { id:'knowns', title:'四个知道', html: `
          ${heading('横向看环境，纵向看能力')}
          <h3>横向四知道 · 决定为什么投、向谁学</h3>
          <div class="research-knowns">
            <article class="research-known"><h3>社会发展</h3><p>评测从回答转向任务交付，同时衡量完成、成本与风险。</p><strong>围绕业务任务定义成功。</strong></article>
            <article class="research-known"><h3>竞争对手</h3><p>美团治理标准，字节分层诊断，AWS 验证结果与过程。</p><strong>逐项对标可验证的能力。</strong></article>
            <article class="research-known"><h3>政策监控</h3><p>按最小必要范围使用评测数据，明确授权、脱敏与保留期限。</p><strong>对外服务时复核适用要求。</strong></article>
            <article class="research-known"><h3>技术发展</h3><p>规则验证事实，模型判断语义，人工处理争议。</p><strong>优先补复算与结果断言。</strong></article>
          </div>
          <h3>纵向四知道 · 决定怎么做、做到哪里</h3>
          <div class="research-knowns">
            <article class="research-known"><h3>学术前沿</h3><p>分别验证任务可靠性、裁判稳定性与故障定位质量。</p><strong>用受控故障测试归因器。</strong></article>
            <article class="research-known"><h3>工业水平</h3><p>将专家、样本、评测和回归接入持续迭代。</p><strong>已确认问题进入固定回归。</strong></article>
            <article class="research-known"><h3>工程架构</h3><p>复用现有 Host、评测链与数据层，补齐验证闭环。</p><strong>在既有入口上扩展。</strong></article>
            <article class="research-known"><h3>自身定位</h3><p>证据底座与校准工具已有，代表性人工验证仍不足。</p><strong>先证明可信度。</strong></article>
          </div>
          ${heading('目标架构：补齐验证闭环')}
          <div class="research-architecture">
            <div class="research-module proposed">${status('拟补','pending')}<strong>样本与人工标准</strong><p>分层抽样、双人盲标、争议仲裁、独立保留集。</p></div><span class="research-arrow" aria-hidden="true">→</span>
            <div class="research-module">${status('已有')}<strong>证据约束评测链</strong><p>共同 Criteria → Attribution → Comparison；按需核验与改写。</p></div><span class="research-arrow" aria-hidden="true">→</span>
            <div class="research-module">${status('已有入口')}<strong>实验与质量统计</strong><p>校准、重复、换位、成簇区间；执行后的质量结果另行验收。</p></div><span class="research-arrow" aria-hidden="true">→</span>
            <div class="research-module proposed">${status('拟补','pending')}<strong>问题回归与门禁</strong><p>问题库引用 → 人工确认 → 修复 → 复测 → 复发监测。</p></div>
          </div>
          ${table(['能力','仓库事实','与标杆的差距','本轮判断'],[
            ['判据与证据','要求拆解、引用坐标、归因与判决边界已有','规则语义是否足够清晰，需人审验证',status('已实现，待校准','partial')],
            ['裁判质量','gold-template / calibrate 已提供','缺代表性人工审定与严重误判结果',status('优先验证','pending')],
            ['稳定性与区间','compare / summarize；六题独立比较实验','样本与评测阶段覆盖仍有限',status('局部已验证','partial')],
            ['任务真实完成','已有来源核验与复算；不是通用环境状态验证器','按业务任务增加可执行结果断言',status('按场景补齐','pending')],
            ['工程运行','可恢复 run、双 SDK、日志与模块边界','工作目录不构成安全沙箱；扩容按实测瓶颈',status('保留底座')]
          ])}
        `},
        { id:'roadmap', title:'建设路线', html: `
          ${heading('建议路线：先验证可信度，再扩大能力')}
          <div class="research-timeline">
            <article class="research-phase"><small>P0 / 第 1–4 周</small><h3>建人工基准</h3><p>责任：业务专家 + 评测负责人</p><ul><li>先双标 30–50 题，覆盖有无标准、数值、工具、未知与核心失败。</li><li>专家先读原题和来源，独立判断后仲裁；划分调优集与保留集。</li><li>直接使用已有 gold-template / calibrate，分析规则分歧。</li></ul><p><strong>交付：</strong>审定样本引用、分歧记录、严重误判清单与基线。</p></article>
            <article class="research-phase"><small>P0 / 第 5–8 周</small><h3>做分层对照</h3><p>责任：评测负责人</p><ul><li>按试点工时扩至 100–200 题，样本规模再按精度目标调整。</li><li>固定上游测组件；另起新 run 测完整评测链路。</li><li>对异模型核验、复算增强分别做单因素实验。</li></ul><p><strong>交付：</strong>正确性、重复/换位稳定性、未知与失败、成本和时延。</p></article>
            <article class="research-phase"><small>P1 / 第 9–12 周</small><h3>跑通回归闭环</h3><p>责任：评测负责人 + 修复责任人</p><ul><li>把高影响问题转成引用原样本的固定回归。</li><li>增加当前高频任务的结果断言与风险反例。</li><li>形成发布前评审；门槛未达时保留人工复核。</li></ul><p><strong>交付：</strong>修复复测记录、回归覆盖、复发率与发布结论。</p></article>
          </div>
          ${heading('每次汇报固定六个口径')}
          ${table(['指标','计算与范围','建议验收方式'],[
            ['人工一致性','只用 reviewed 的审定条目；结果类型与真实赢家同时核对','报告分母、分类混淆和区间；不只报一个总比例'],
            ['严重误判','核心失败判可用、证据冲突漏判、责任错归等人工确认错误','受控严重反例建议零漏过；保留集按预声明容忍度验收'],
            ['重复与换位','固定材料测裁判；重新生成被测任务测 Agent 可靠性','两类实验分别报告，至少三次独立 run'],
            ['未知、失败和缺失','均单列数量与占比，未决不按平局处理','未知下降要同时检查误判是否增加'],
            ['改进收益','同一 case 成对比较，按 case 处理同题相关性','置信区间不能支持提升时，结论写“证据不足”'],
            ['费用与时延','被评系统、评测器分开；费用采用当次可核实计费口径','每个已接受结果成本、人工工时、耗时分位数同时报告']
          ])}
          ${heading('6 个月 / 1 年 / 2 年：每一步都有进入条件')}
          ${table(['时间','目标','进入下一阶段的依据'],[
            ['6 个月','核心业务覆盖、稳定人工校准、问题回归可重复运行','连续迭代能解释质量、成本和失败的变化'],
            ['1 年','按业务扩展长任务、多模态与有限环境状态验证','任务规模与故障数据证明需要扩展；数据与权限边界确认'],
            ['2 年','形成可对外复核的协议、脱敏案例与对照结果','获得数据授权，并在同分布外部对照中验证可比性']
          ])}
        `},
        { id:'sources', title:'来源与全文', html: `
          ${heading('来源与完整研究')}
          <p>资料获取：${escape(data.date)}</p>
          <details class="research-document"><summary>完整“四个知道”研究报告</summary><article>${data.reportHtml}</article></details>
          <ol class="research-sources">${data.sources.map(source => `<li><a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer">[${source.number}] ${escape(source.title)}</a><p>${escape(source.date)} · ${escape(source.note)}</p></li>`).join('')}</ol>
          <div class="research-callout"><strong>本地事实来源</strong>docs/quality.md（实验与校准）；scripts/benchmark-analysis.mjs（统计与金标）；docs/architecture.md（模块与执行边界）；evaluation-report/README.md（案例和实验来源）。现有案例仍保留 r151/r152 来源，提示词快照为 r153；本轮仅更新研究与展示。</div>
        `}
      ];
      container.innerHTML = `<div class="research-hero"><div><h1>从可运行的评测<br>走向可证明的质量</h1><p>对标美团与字节，明确当前能力、差距与建设路线。</p></div><aside class="research-decision"><h2>本轮建议</h2><p><strong>人工校准 · 分层实验 · 问题回归</strong></p></aside></div>
        <div class="research-nav" role="tablist" aria-label="行业对标章节">${panels.map((panel, index) => `<button type="button" role="tab" id="research-tab-${panel.id}" data-research-tab="${panel.id}" aria-controls="research-panel-${panel.id}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${panel.title}</button>`).join('')}</div>
        ${panels.map((panel, index) => `<section class="research-panel" id="research-panel-${panel.id}" role="tabpanel" tabindex="0" aria-labelledby="research-tab-${panel.id}"${index ? ' hidden' : ''}>${panel.html}</section>`).join('')}`;
      const tabs = [...container.querySelectorAll('[data-research-tab]')];
      function select(tab) {
        for (const item of tabs) { item.setAttribute('aria-selected', String(item === tab)); item.tabIndex = item === tab ? 0 : -1; }
        for (const panel of container.querySelectorAll('.research-panel')) panel.hidden = panel.id !== tab.getAttribute('aria-controls');
        const top = container.querySelector('.research-hero').getBoundingClientRect().bottom + window.scrollY;
        if (window.scrollY > top) window.scrollTo(0, top);
      }
      for (const [index, tab] of tabs.entries()) {
        tab.addEventListener('click', () => select(tab));
        tab.addEventListener('keydown', event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
          if (next === null) return;
          event.preventDefault(); select(tabs[next]); tabs[next].focus();
        });
      }
    }
  };
})();
