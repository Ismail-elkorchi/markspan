function escapeText(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function escapeAttribute(value) {
  return escapeText(value);
}

function normalizeDestination(value) {
  return encodeURI(value).replaceAll('%25', '%');
}

function inlineText(nodes) {
  let result = '';
  for (const node of nodes) {
    if ('value' in node && typeof node.value === 'string') result += node.value;
    else if ('children' in node) result += inlineText(node.children);
    else if (node.kind === 'softBreak' || node.kind === 'hardBreak') result += '\n';
    else if (node.kind === 'footnoteReference') result += node.label;
  }
  return result;
}

const filteredGfmTags = new Set([
  'iframe', 'noembed', 'noframes', 'plaintext', 'script', 'style', 'textarea', 'title', 'xmp'
]);

function filteredHtml(value, context) {
  if (context.dialect !== 'gfm') return value;
  return value.replace(/<(\/?)([A-Za-z][A-Za-z0-9-]*)(?=[\t\n />]|$)/gu, (match, slash, name) => (
    filteredGfmTags.has(name.toLowerCase()) ? `&lt;${slash}${name}` : match
  ));
}

function footnoteSlug(label) {
  return encodeURI(label).replaceAll('%5B', '[').replaceAll('%5D', ']');
}

function renderFootnoteReference(node, context) {
  let entry = context.footnotes.get(node.normalizedLabel);
  if (entry === undefined) {
    entry = {
      ordinal: context.footnotes.size + 1,
      slug: footnoteSlug(node.normalizedLabel),
      references: 0,
      definition: context.definitions.get(node.normalizedLabel)
    };
    context.footnotes.set(node.normalizedLabel, entry);
  }
  entry.references += 1;
  const suffix = entry.references === 1 ? '' : `-${entry.references}`;
  return `<sup class="footnote-ref"><a href="#fn-${entry.slug}" id="fnref-${entry.slug}${suffix}" data-footnote-ref>${entry.ordinal}</a></sup>`;
}

function renderInlines(nodes, context) {
  let result = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
      case 'escape':
      case 'characterReference':
        result += escapeText(node.value);
        break;
      case 'emphasis':
        result += `<em>${renderInlines(node.children, context)}</em>`;
        break;
      case 'strong':
        result += `<strong>${renderInlines(node.children, context)}</strong>`;
        break;
      case 'strikethrough':
        result += `<del>${renderInlines(node.children, context)}</del>`;
        break;
      case 'codeSpan':
        result += `<code>${escapeText(node.value)}</code>`;
        break;
      case 'link': {
        const title = node.title === null ? '' : ` title="${escapeAttribute(node.title)}"`;
        result += `<a href="${escapeAttribute(normalizeDestination(node.destination))}"${title}>${renderInlines(node.children, context)}</a>`;
        break;
      }
      case 'image': {
        const title = node.title === null ? '' : ` title="${escapeAttribute(node.title)}"`;
        result += `<img src="${escapeAttribute(normalizeDestination(node.destination))}" alt="${escapeAttribute(inlineText(node.children))}"${title} />`;
        break;
      }
      case 'softBreak':
        result += '\n';
        break;
      case 'hardBreak':
        result += '<br />\n';
        break;
      case 'htmlInline':
        result += filteredHtml(node.value, context);
        break;
      case 'footnoteReference':
        result += renderFootnoteReference(node, context);
        break;
    }
  }
  return result;
}

function renderListItem(item, tight, context) {
  let content = '';
  let startsWithBlock = false;
  for (let index = 0; index < item.children.length; index += 1) {
    const block = item.children[index];
    if (tight && block.kind === 'paragraph') {
      const task = index === 0 && item.task !== null
        ? `<input type="checkbox"${item.task.checked ? ' checked=""' : ''} disabled="" /> `
        : '';
      content += task + renderInlines(block.children, context);
      if (index + 1 < item.children.length) content += '\n';
    } else {
      if (index === 0) startsWithBlock = true;
      const rendered = renderBlocks([block], context);
      content += index === 0 && item.task !== null && block.kind === 'paragraph'
        ? rendered.replace('<p>', `<p><input type="checkbox"${item.task.checked ? ' checked=""' : ''} disabled="" /> `)
        : rendered;
    }
  }
  return `<li>${startsWithBlock ? '\n' : ''}${content}</li>\n`;
}

function renderTable(table, context) {
  const cell = (value, header, column) => {
    const alignment = table.align[column];
    const attribute = alignment === null || alignment === undefined ? '' : ` align="${alignment}"`;
    const tag = header ? 'th' : 'td';
    return `<${tag}${attribute}>${renderInlines(value.children, context)}</${tag}>\n`;
  };
  let result = '<table>\n<thead>\n<tr>\n';
  for (const value of table.header.cells) result += cell(value, true, value.column);
  result += '</tr>\n</thead>\n';
  if (table.rows.length > 0) {
    result += '<tbody>\n';
    for (const row of table.rows) {
      result += '<tr>\n';
      for (const value of row.cells) result += cell(value, false, value.column);
      result += '</tr>\n';
    }
    result += '</tbody>\n';
  }
  return `${result}</table>\n`;
}

export function renderBlocks(blocks, context = { dialect: 'commonmark', definitions: new Map(), footnotes: new Map() }) {
  let result = '';
  for (const block of blocks) {
    switch (block.kind) {
      case 'paragraph':
        result += `<p>${renderInlines(block.children, context)}</p>\n`;
        break;
      case 'heading':
        result += `<h${block.depth}>${renderInlines(block.children, context)}</h${block.depth}>\n`;
        break;
      case 'blockQuote':
        result += `<blockquote>\n${renderBlocks(block.children, context)}</blockquote>\n`;
        break;
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : '';
        result += `<${tag}${start}>\n`;
        for (const item of block.items) result += renderListItem(item, block.tight, context);
        result += `</${tag}>\n`;
        break;
      }
      case 'codeBlock': {
        const language = block.style === 'fenced' && block.language !== null
          ? ` class="language-${escapeAttribute(block.language)}"`
          : '';
        const value = block.value.length === 0 ? '' : `${escapeText(block.value)}\n`;
        result += `<pre><code${language}>${value}</code></pre>\n`;
        break;
      }
      case 'thematicBreak':
        result += '<hr />\n';
        break;
      case 'htmlBlock':
        result += filteredHtml(block.value.endsWith('\n') ? block.value : `${block.value}\n`, context);
        break;
      case 'linkDefinition':
      case 'footnoteDefinition':
        break;
      case 'table':
        result += renderTable(block, context);
        break;
    }
  }
  return result;
}

export function renderConformanceDocument(document) {
  const definitions = new Map();
  const pending = [...document.tree.children];
  while (pending.length > 0) {
    const block = pending.pop();
    if (block === undefined) continue;
    if (block.kind === 'footnoteDefinition' && block.active) definitions.set(block.normalizedLabel, block);
    if (block.kind === 'blockQuote' || block.kind === 'footnoteDefinition') pending.push(...block.children);
    else if (block.kind === 'list') {
      for (const item of block.items) pending.push(...item.children);
    }
  }
  const context = {
    dialect: document.metadata?.dialect ?? 'commonmark',
    definitions,
    footnotes: new Map()
  };
  let result = renderBlocks(document.tree.children, context);
  if (context.footnotes.size === 0) return result;
  result += '<section class="footnotes" data-footnotes>\n<ol>\n';
  for (const entry of [...context.footnotes.values()].sort((left, right) => left.ordinal - right.ordinal)) {
    if (entry.definition === undefined) continue;
    const links = [];
    for (let reference = 1; reference <= entry.references; reference += 1) {
      const suffix = reference === 1 ? '' : `-${reference}`;
      const index = reference === 1 ? `${entry.ordinal}` : `${entry.ordinal}-${reference}`;
      const content = reference === 1 ? '↩' : `↩<sup class="footnote-ref">${reference}</sup>`;
      links.push(`<a href="#fnref-${entry.slug}${suffix}" class="footnote-backref" data-footnote-backref data-footnote-backref-idx="${index}" aria-label="Back to reference ${index}">${content}</a>`);
    }
    let body = renderBlocks(entry.definition.children, context);
    const backrefs = links.join(' ');
    if (body.endsWith('</p>\n')) body = `${body.slice(0, -5)} ${backrefs}</p>\n`;
    else body += `${backrefs}\n`;
    result += `<li id="fn-${entry.slug}">\n${body}</li>\n`;
  }
  return `${result}</ol>\n</section>\n`;
}
