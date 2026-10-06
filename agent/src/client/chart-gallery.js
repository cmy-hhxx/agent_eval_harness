import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AnalysisChart } from './charts.js';
import { chartTemplates } from './chart-templates.js';
import { chartTheme } from './chart-theme.js';
import './charts.css';
import './chart-gallery.css';

function Gallery() {
  const [family, setFamily] = useState('全部'), [query, setQuery] = useState(''), [copied, setCopied] = useState('');
  const templates = chartTemplates.filter(t => (family === '全部' || family === t.family) && `${t.name}${t.chart.title}${t.chart.type}`.toLowerCase().includes(query.toLowerCase()));
  const copy = async template => {
    try { await navigator.clipboard.writeText(JSON.stringify(template.chart, null, 2)); setCopied(template.id); }
    catch { setCopied('error'); }
  };
  return h('main', null,
    h('header', { className: 'gallery-header' }, h('div', null, h('p', { className: 'gallery-brand' }, 'ERIS / VISUAL LAB'), h('h1', null, '科研图形模板'), h('p', null, `${chartTemplates.length} 个本地模板 · ${new Set(chartTemplates.map(t => t.chart.type)).size} 种图形 · 示例数据`)),
      h('div', { className: 'gallery-palette', 'aria-label': '参考配色' }, ['navy', 'royal', 'denim', 'coral', 'terracotta', 'ivory', 'earth'].map(key => h('span', { key }, h('i', { style: { background: chartTheme[key] } }), h('code', null, chartTheme[key]))))),
    h('nav', { className: 'gallery-filters', 'aria-label': '模板分类' }, ['全部', '环形', '比较', '结构', '关系', '分布', '趋势'].map(name => h('button', { key: name, 'aria-pressed': family === name, onClick: () => setFamily(name) }, name)),
      h('input', { type: 'search', 'aria-label': '搜索模板', placeholder: '搜索模板', value: query, onChange: e => setQuery(e.target.value) })),
    copied === 'error' ? h('p', { role: 'alert' }, '复制失败：浏览器未授予剪贴板权限。') : null,
    templates.length ? h('section', { className: 'gallery-grid', 'aria-label': '模板预览' }, templates.map(template => h('article', { key: template.id, 'data-template': template.id },
      h('div', { className: 'gallery-card-heading' }, h('h2', null, template.name), h('button', { onClick: () => copy(template) }, copied === template.id ? '已复制' : '复制数据模板')),
      h(AnalysisChart, { chart: template.chart })))) : h('p', { role: 'status' }, '没有匹配的模板'),
    h('footer', { className: 'gallery-footer' }, 'Eris · 本地模板库 · 示例不代表评测结论'));
}
createRoot(document.getElementById('root')).render(h(Gallery));
