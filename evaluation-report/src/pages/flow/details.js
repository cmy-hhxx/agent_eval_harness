(() => {
  'use strict';
  const statusNames = {met:'满足',partial:'部分满足',unmet:'未满足',unknown:'待核实',not_applicable:'不适用'};
  const importanceNames = {high:'高',medium:'中',low:'低'};
  const dimensionNames = {correctness:'正确性',completeness:'完整性',relevance:'相关性',reasoning:'推理',instruction_following:'指令遵循',evidence_quality:'证据质量',format:'格式',presentation:'表达',efficiency:'效率'};
  const stageNames = {final_answer:'最终回答',reasoning:'推理过程',execution:'执行过程',context_recall:'上下文召回',tool_call:'工具调用',tool_result:'工具返回'};
  const sourceText = source => source ? `${source.file}${source.line ? ` · 第 ${source.line} 行` : ''}${source.pointer ? ` · ${source.pointer}` : ''}` : '';
  const valueText = value => typeof value === 'string' ? value : JSON.stringify(value);

  window.ReportDetails = {
    renderCheck(body, {pair, candidate, anonymous}) {
      const document = body.ownerDocument;
      const describe = value => anonymous(String(value ?? ''));
      const make = (tag, value, className, attributes = {}) => {
        const node = document.createElement(tag);
        if (value !== undefined) node.textContent = String(value);
        if (className) node.className = className;
        for (const [name, item] of Object.entries(attributes)) node.setAttribute(name, String(item));
        return node;
      };
      const paragraph = (parent, value, attributes = {}) => {
        if (value !== undefined && value !== null && value !== '') parent.append(make('p', describe(value), '', attributes));
      };
      const field = (list, label, value, attributes = {}) => {
        if (value === undefined || value === null || value === '') return;
        list.append(make('dt', label), make('dd', describe(value), '', attributes));
      };
      const evidence = (parent, entries, kind) => {
        const list = make('div', undefined, 'check-detail-evidence');
        entries.forEach((entry, index) => {
          const detail = make('details', undefined, '', {'data-check-evidence':kind,'data-evidence-index':index,'data-evidence-id':entry.evidence_id});
          detail.append(make('summary', `证据 ${index + 1} · ${entry.quoteTruncated ? '摘录' : '原文'} · 消息 ${entry.message_index}`));
          // Evidence remains a literal source quote; identity replacement applies only to evaluator prose.
          detail.append(make('pre', entry.quoteExcerpt, '', {'data-evidence-quote':''}));
          if (entry.provenance) detail.append(make('p', sourceText(entry.provenance), 'source-reference'));
          list.append(detail);
        });
        if (entries.length) parent.append(list);
      };
      const root = make('div', undefined, 'check-detail-output', {'data-check-output':candidate.inputId});
      const core = make('section', undefined, 'detail-assessment check-detail-core', {'data-check-core':''});
      core.append(make('h3', candidate.core.meets_core === true ? '核心可用' : candidate.core.meets_core === false ? '核心不可用' : '核心待核'));
      paragraph(core, candidate.core.reason, {'data-check-core-reason':''});
      if (candidate.core.criterion_ids.length) core.append(make('p', `核心判据 · ${candidate.core.criterion_ids.join('、')}`, 'check-detail-meta', {'data-check-core-criteria':''}));
      root.append(core);
      if (candidate.summary && candidate.summary !== candidate.core.reason) {
        const summary = make('section', undefined, 'detail-assessment');
        summary.append(make('h3', '归因总结'));
        paragraph(summary, candidate.summary, {'data-check-summary':''});
        root.append(summary);
      }

      if (pair.hasStandardAnswer) {
        const correctness = make('section', undefined, 'detail-assessment check-detail-correctness', {'data-check-correctness':''});
        correctness.append(make('h3', '标准答案核对'));
        const states = make('div', undefined, 'check-detail-status');
        states.append(make('strong', candidate.isCorrect === true ? '匹配标准' : candidate.isCorrect === false ? '未匹配标准' : '标准核对待定', '', {'data-correctness-state':String(candidate.isCorrect)}));
        if (candidate.standardConflict) states.append(make('span', '标准冲突', 'check-detail-conflict', {'data-standard-conflict':''}));
        correctness.append(states);
        const values = make('dl', undefined, 'check-detail-fields');
        values.append(make('dt', '标准答案'), make('dd', valueText(pair.groundTruth.value), '', {'data-check-standard-value':''}));
        correctness.append(values);
        paragraph(correctness, candidate.correctnessReason, {'data-check-correctness-reason':''});
        if (candidate.numericChecks.length) {
          const tableWrap = make('div', undefined, 'check-detail-numeric-wrap');
          const table = make('table', undefined, 'check-detail-numeric', {'data-check-numeric':''});
          table.append(make('caption', '数值核对'));
          const head = make('thead'), header = make('tr');
          ['核对项','标准值','回答值','换算系数','方式','结果','证据'].forEach(label => header.append(make('th',label,'',{scope:'col'})));
          head.append(header);table.append(head);
          const rows = make('tbody');
          candidate.numericChecks.forEach((check,index) => {
            const row = make('tr', undefined, '', {'data-numeric-index':index,'data-numeric-evidence-index':check.evidence_index});
            row.append(make('th', describe(check.label), '', {scope:'row','data-numeric-field':'label'}));
            for (const name of ['expected','actual','scale']) row.append(make('td', check[name] === null ? '未给出' : check[name], '', {'data-numeric-field':name,'data-value-available':check[name] !== null}));
            row.append(make('td', ({exact:'精确匹配',rounded:'按精度核对'})[check.mode] || check.mode, '', {'data-numeric-mode':check.mode}));
            row.append(make('td', check.matches ? '一致' : '不一致', '', {'data-numeric-matches':String(check.matches)}));
            row.append(make('td', `证据 ${check.evidence_index + 1}`));
            rows.append(row);
          });
          table.append(rows);tableWrap.append(table);correctness.append(tableWrap);
        }
        evidence(correctness, candidate.correctnessEvidence, 'correctness');
        root.append(correctness);
      }

      const requirements = make('section', undefined, 'check-detail-requirements');
      requirements.append(make('h3', `逐项核验 · ${candidate.criteriaAssessments.length} 项`));
      candidate.criteriaAssessments.forEach(assessment => {
        const criterion = pair.criteria.find(rule => rule.id === assessment.criterion_id);
        const section = make('section', undefined, 'detail-assessment', {'data-check-assessment':assessment.criterion_id});
        section.append(make('h4', `${assessment.criterion_id} · ${statusNames[assessment.status] || assessment.status}${assessment.evidence_status === 'uncertain' ? ' · 待核实' : ''}`, '', {'data-assessment-status':assessment.status,'data-assessment-evidence-status':assessment.evidence_status}));
        if (criterion) {
          paragraph(section, criterion.text, {'data-criterion-text':''});
          const groupName = {requirements:'要求',scoring_points:'加分项',red_flags:'红线'}[criterion.group];
          section.append(make('p', `${criterion.scope === 'shared' ? '共同' : '候选专属'}${groupName}`, 'check-detail-meta', {'data-criterion-scope':criterion.scope}));
          const rule = make('details', undefined, 'check-detail-rule');
          rule.append(make('summary', '验收规则'), make('p', describe(criterion.acceptance_rule), '', {'data-criterion-acceptance':''}));
          section.append(rule);
        }
        paragraph(section, assessment.summary, {'data-assessment-summary':''});
        evidence(section, assessment.evidence || [], 'criterion');
        requirements.append(section);
      });
      root.append(requirements);

      for (const type of ['strength','problem']) {
        const findings = candidate.findings.filter(finding => finding.type === type);
        if (!findings.length) continue;
        const group = make('section', undefined, 'check-detail-findings', {'data-check-finding-group':type});
        group.append(make('h3', `${type === 'strength' ? '优点' : '问题'} · ${findings.length} 项`));
        findings.forEach(finding => {
          const section = make('section', undefined, 'detail-assessment', {'data-check-finding':finding.finding_id});
          section.append(make('h4', describe(finding.text), '', {'data-finding-text':''}));
          section.append(make('p', `${finding.finding_id} · ${dimensionNames[finding.dimension] || finding.dimension} · ${stageNames[finding.stage] || finding.stage} · 重要性${importanceNames[finding.importance] || finding.importance}${finding.assessment.evidence_status === 'uncertain' ? ' · 待核实' : ''}`, 'check-detail-meta', {'data-finding-evidence-status':finding.assessment.evidence_status}));
          const fields = make('dl', undefined, 'check-detail-fields');
          field(fields, '判断依据', finding.reason, {'data-finding-reason':''});
          if (finding.assessment.observation !== finding.text) field(fields, '实际观察', finding.assessment.observation, {'data-finding-observation':''});
          if (finding.assessment.impact !== finding.reason) field(fields, '交付影响', finding.assessment.impact, {'data-finding-impact':''});
          if (finding.problem) {
            field(fields, '责任组件', finding.problem.component.map(c => `${c.role==='primary'?'主责':'关联'}：${c.technical_domain}/${c.functional_component} · ${c.component}（${c.certainty==='confirmed'?'确证':'推断'}）`).join('；'), {'data-problem-components':''});
            field(fields, '问题名称', finding.problem.label, {'data-problem-label':''});
            field(fields, '责任说明', finding.problem.definition, {'data-problem-definition':''});
          }
          if (Number.isInteger(finding.assessment.requirement_index)) {
            const criterion = pair.criteria.filter(rule => rule.group === 'requirements')[finding.assessment.requirement_index];
            if (criterion) field(fields, '关联要求', `${criterion.id} · ${criterion.text}`, {'data-finding-requirement':''});
          }
          section.append(fields);
          evidence(section, finding.evidence || [], 'finding');
          group.append(section);
        });
        root.append(group);
      }
      root.append(make('p', sourceText(candidate.provenance.attribution), 'source-reference', {'data-check-source':''}));
      body.replaceChildren(root);
    },
  };
})();
