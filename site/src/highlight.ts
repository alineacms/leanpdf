/**
 * Build-time syntax highlighting for the few languages the site shows (TypeScript/JavaScript and
 * shell). Deliberately small: comments, strings, keywords, numbers, types and commands, as
 * <span class="tok-…"> around HTML-escaped text.
 */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }[c]};`);
}

const KEYWORDS = new Set(
  (
    'import export from const let var await async function return new interface type readonly extends implements class ' +
    'if else for of in while do try catch finally throw typeof instanceof as default null undefined true false this void ' +
    'keyof satisfies enum declare'
  ).split(' '),
);

const TS_TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`)|\b(\d[\d_]*(?:\.\d+)?)\b|([A-Za-z_$][\w$]*)/g;

const span = (cls: string, text: string): string => `<span class="tok-${cls}">${escapeHtml(text)}</span>`;

function highlightTs(code: string): string {
  let out = '';
  let last = 0;
  for (const m of code.matchAll(TS_TOKEN)) {
    const i = m.index ?? 0;
    out += escapeHtml(code.slice(last, i));
    last = i + m[0].length;
    const [text, comment, string, number, ident] = m;
    if (comment) out += span('c', text);
    else if (string) out += span('s', text);
    else if (number) out += span('n', text);
    else if (ident && KEYWORDS.has(ident)) out += span('k', text);
    else if (ident && /^[A-Z]/.test(ident)) out += span('t', text);
    else if (ident && code[last] === '(') out += span('f', text);
    else out += escapeHtml(text);
  }
  return out + escapeHtml(code.slice(last));
}

function highlightShell(code: string): string {
  return code
    .split('\n')
    .map((line) => {
      const hash = /(^|\s)#/.exec(line);
      const body = hash ? line.slice(0, hash.index + hash[1].length) : line;
      const comment = hash ? line.slice(hash.index + hash[1].length) : '';
      const m = /^(\s*)(\S+)(.*)$/.exec(body);
      let html = m ? `${m[1]}${span('f', m[2])}${escapeHtml(m[3]).replace(/(^|\s)(--?[\w-]+)/g, '$1<span class="tok-k">$2</span>')}` : escapeHtml(body);
      if (comment) html += span('c', comment);
      return html;
    })
    .join('\n');
}

/** Highlighted HTML for a code block (without the surrounding <pre><code>). */
export function highlight(code: string, lang: string): string {
  switch (lang) {
    case 'ts':
    case 'typescript':
    case 'js':
    case 'javascript':
    case 'mjs':
      return highlightTs(code);
    case 'sh':
    case 'shell':
    case 'bash':
    case 'console':
      return highlightShell(code);
    default:
      return escapeHtml(code);
  }
}

/** A complete code block, with a language label the copy-button script can use. */
export function codeBlock(code: string, lang = '', label?: string): string {
  const title = label ?? { ts: 'TypeScript', typescript: 'TypeScript', js: 'JavaScript', sh: 'Shell', bash: 'Shell', shell: 'Shell' }[lang];
  const head = title ? `<div class="code-head"><span>${escapeHtml(title)}</span></div>` : '';
  return `<div class="code">${head}<pre tabindex="0"><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>${highlight(code.replace(/\n+$/, ''), lang)}</code></pre></div>`;
}
